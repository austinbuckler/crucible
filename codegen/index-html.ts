import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeIfChanged } from "./write-if-changed.ts";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

// Generates `.crucible/index.html`. Crucible owns it: re-emitted on every
// codegen run. Vite is configured (in vite.config.ts) to use `.crucible`
// as its `root`, so this is the file the dev server + production build
// both consume.
//
// Splash flow:
//   1. `src/app/splash.tsx` default export is rendered to static HTML and
//      inlined as the splash, visible *before* any JS bundle parses.
//   2. Top-level `beforeMount(() => {…})` calls in that file are extracted
//      at codegen time, TS-stripped, and inlined as `<script>` blocks. The
//      callbacks run as soon as the browser parses the inline script.
//   3. User code calls `Crucible.dismissSplashScreen()` when the app is
//      ready (auth resolved, etc.) — this dispatches `crucible:mounted`
//      which the inline script listens for.
//
// HTML conforms to the mobile-app PWA guidelines (hex bg colors, hex
// theme-color, viewport-fit=cover, apple meta tags for installed PWA
// experience, safe-area-aware splash padding, no rubber-band, no tap
// highlight, native body sizing via 100dvh).

// Pair-form background. The splash + reset CSS pick the right value based
// on the active color mode — system preference (`prefers-color-scheme`)
// composed with persisted user choice. Hex strings only (iOS Safari can't
// parse `oklch()` for the splash; we keep parity with the rest of the
// metadata system).
export type SplashBackgroundColor =
  | string
  | { light: string; dark: string };

// Theme storage strategy used by the boot script when `splashBackgroundColor`
// is dual-form. The script reads `localStorage[storageKey]` and applies
// the active mode to `<html>` BEFORE first paint, so the splash CSS rules
// pick the right color without a flash.
//
// `attribute` mirrors the convention the consumer's runtime ThemeProvider
// uses to advertise "dark mode is active":
//   - `"class"`     → adds the literal class `dark` to `<html>` (Tailwind
//                     v4 / shadcn convention).
//   - `"data-theme"` → sets `<html data-theme="dark">` (next-themes
//                     default).
//
// Both forms are emitted in the CSS rules either way, so the splash works
// even if the runtime provider re-applies the convention via a different
// path post-boot. Defaults match next-themes (`storageKey: "theme"`,
// `attribute: "class"` is the most common consumer choice today).
export type ThemeStorage = {
  storageKey: string;
  attribute: "class" | "data-theme";
};

export type IndexHtmlOpts = {
  appRoot: string;
  // Title rendered into <title> before React boots.
  fallbackTitle?: string;
  // OS chrome color emitted as `<meta name="theme-color">`. Distinct from
  // the splash background (which is the CSS bg of <html>/<body>/the splash
  // overlay) — chrome color is the status-bar/title-bar tint the OS picks.
  // Single value only because `<meta name="theme-color">` is hex-only and
  // doesn't have a "dark" variant the browser respects pre-paint.
  fallbackThemeColor?: string;
  // Splash + reset-CSS background color. Single hex applies in both
  // modes. Pair form picks the right value at first paint based on the
  // user's persisted theme choice (read from `localStorage[storageKey]`,
  // see `themeStorage` below) composed with `prefers-color-scheme`.
  fallbackBackgroundColor?: SplashBackgroundColor;
  // When `fallbackBackgroundColor` is dual-form, the boot script needs to
  // know which storage key to read and which attribute/class convention
  // to apply on `<html>` so the CSS rules below pick the right color.
  // Ignored when `fallbackBackgroundColor` is a single string.
  themeStorage?: ThemeStorage;
  // Extra origins appended to the CSP `connect-src` directive, on top of
  // the default `'self' ws: wss:` (same-origin XHR/fetch + dev HMR
  // sockets). Use this for any third-party API origins the app talks to —
  // e.g. `["https://api.posthog.com", "https://*.sentry.io"]`. Each entry
  // is included verbatim; provide full schemes.
  connectSrcAllowlist?: ReadonlyArray<string>;
};

const SPLASH_ID = "crucible-splash";
const SPLASH_HIDDEN_CLASS = "crucible-splash-hidden";
const FADE_MS = 220;
const DEFAULT_BG = "#ffffff";

const DEFAULT_THEME_STORAGE: ThemeStorage = {
  // Mirrors next-themes' default storage key. Verified at
  // `node_modules/.bun/next-themes@0.4.6+8f708e3022b846db/node_modules/next-themes/dist/index.js`
  // — `storageKey:o="theme"` and `attribute:h="data-theme"`. We default to
  // `"class"` for the attribute because the typical Crucible consumer pairs
  // shadcn/ui (Tailwind v4 dark variant on `.dark`) over next-themes'
  // class-mode preset. Override per-app via `themeStorage`.
  storageKey: "theme",
  attribute: "class",
};

// Default dismissal: listens for `crucible:mounted` and toggles the hidden
// class so the CSS opacity transition plays. Used when the user didn't
// author any `beforeMount` calls.
const DEFAULT_DISMISS_SCRIPT = `
window.addEventListener("crucible:mounted", function () {
  var s = document.getElementById("${SPLASH_ID}");
  if (!s) return;
  s.classList.add("${SPLASH_HIDDEN_CLASS}");
  s.addEventListener("transitionend", function () { s.remove(); }, { once: true });
});
`;

export async function emitIndexHtml(opts: IndexHtmlOpts): Promise<void> {
  const outDir = join(opts.appRoot, ".crucible");
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, "index.html");

  const splash = await loadSplashIfPresent(opts.appRoot);
  const title = opts.fallbackTitle ?? "";
  const bg = normalizeBackground(opts.fallbackBackgroundColor);
  const chromeColor = opts.fallbackThemeColor ?? bg.light;
  const themeStorage = opts.themeStorage ?? DEFAULT_THEME_STORAGE;

  // Per-build nonce. Stamped onto every inline <script> and <style> we
  // emit, and referenced from the CSP header — letting us drop
  // 'unsafe-inline' entirely. Any future inline content injected via XSS
  // (stored or reflected) won't carry the nonce and will be blocked by
  // the browser. New build → new nonce, generated by `randomBytes`.
  const nonce = randomBytes(16).toString("base64");
  const nonceAttr = ` nonce="${nonce}"`;

  // Boot-theme script: only emitted when the splash background is
  // dual-form. Reads the persisted theme synchronously, falls back to
  // `prefers-color-scheme`, and stamps the right class/attribute onto
  // `<html>` so the splash CSS rules below pick the right color before
  // the browser paints. Without this, a dark-mode user gets a white
  // flash for the duration of the splash.
  const bootThemeScript = bg.dark
    ? buildBootThemeScript(themeStorage)
    : null;
  const bootThemeTag = bootThemeScript
    ? `<script${nonceAttr}>${bootThemeScript}</script>`
    : "";

  const inlineScripts: string[] = [];
  if (splash) {
    if (splash.beforeMountSnippets.length > 0) {
      // `stripTsTypes` already wrapped each snippet as `(…)();` before
      // transpiling, so the strings are complete statements ready to
      // inline as-is.
      inlineScripts.push(...splash.beforeMountSnippets);
    } else {
      inlineScripts.push(DEFAULT_DISMISS_SCRIPT);
    }
  }
  const scriptTag =
    inlineScripts.length > 0
      ? `<script${nonceAttr}>${inlineScripts.join("\n")}</script>`
      : "";

  const csp = buildCsp(nonce, { connectSrcAllowlist: opts.connectSrcAllowlist });

  const content = `<!doctype html>
<!--
  THIS FILE IS GENERATED BY CRUCIBLE - DO NOT EDIT.
  Customize app-wide metadata via src/app/layout.tsx metadata export,
  the splash screen via src/app/splash.tsx, and the PWA manifest via
  src/app/manifest.ts.
-->
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="light dark" />
    <!-- Nonce-based CSP. The build emits a fresh nonce per index.html and
         stamps it on every inline <script> / <style> we control. Inline
         content injected via XSS (stored or reflected) won't carry the
         nonce and the browser will block it. 'unsafe-eval' is omitted —
         Electron warns on it and it's a real XSS amplifier; React's
         compiler-generated code does not require it. -->
    <meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}" />
    <!-- Initial theme-color matches the splash background so the OS chrome
         doesn't flash a different color at boot. AppShell's runtime metadata
         system (DocumentHead) updates this per-route after React mounts. -->
    <meta name="theme-color" content="${escapeHtml(chromeColor)}" />
    ${bootThemeTag}
    <!-- Installed-PWA meta tags. Static so iOS / Android pick them up at
         "Add to Home Screen" time without waiting for React. -->
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <!-- Stops Safari/iOS from turning runs of digits in body copy into
         tap-to-call links. Other detectors (date, address, email) are
         app-level decisions; an app wanting stricter format-detection
         should override the meta in its own head. Crucible only ships
         the universal default. -->
    <meta name="format-detection" content="telephone=no" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <title>${escapeHtml(title)}</title>
    <style${nonceAttr}>${buildResetCss(bg)}</style>
  </head>
  <body>${
    splash
      ? `\n    <div id="${SPLASH_ID}">${splash.html}</div>${scriptTag}`
      : ""
  }
    <div id="root"></div>
    <script type="module"${nonceAttr} src="./main.tsx"></script>
  </body>
</html>
`;
  writeIfChanged(file, content);
}

// Build the CSP string. Inline script/style use `'nonce-<nonce>'` instead
// of `'unsafe-inline'`, which is the entire reason for nonce-based CSP:
// any inline content injected via XSS (stored or reflected) won't carry
// the nonce and will be blocked by the browser.
//
// `'strict-dynamic'` is intentionally omitted — Vite's dev server emits
// `<script type="module">` modules from the file system, and
// `strict-dynamic` would interfere with how Vite injects HMR client
// scripts during dev. The nonce alone is sufficient defense for our
// threat model (XSS via untrusted user content).
//
export type CspOpts = {
  // Origins appended to `connect-src` on top of the default
  // `'self' ws: wss:`. Each entry is included verbatim — pass full
  // schemes (e.g. `"https://api.example.com"`).
  connectSrcAllowlist?: ReadonlyArray<string>;
};

// Exported for tests; not part of the public plugin surface.
export function buildCsp(nonce: string, opts: CspOpts = {}): string {
  // Default `connect-src` is intentionally tight: same-origin XHR/fetch
  // plus `ws:`/`wss:` (Vite HMR + WebSocket APIs). Apps that talk to a
  // third-party origin must opt in via `connectSrcAllowlist` — wide-open
  // `http: https:` would let any compromised dependency exfiltrate data
  // anywhere on the web.
  //
  // Defense in depth: reject any allowlist entry containing `;` or
  // whitespace. The CSP grammar uses `;` to separate directives, so a
  // value like `"https://evil.com; script-src *"` smuggled into the list
  // would inject `script-src *` and unlock arbitrary script. Plugin
  // config from vite.config.ts is trusted today, but the cost of
  // validation is zero and a future code path that reads this from a
  // less-trusted source (env var, config file) fails closed instead of
  // open.
  const allowlist = (opts.connectSrcAllowlist ?? []).map((entry) => {
    if (/[;\s]/.test(entry)) {
      throw new Error(
        `[crucible] connectSrcAllowlist entry contains a semicolon or whitespace: ${JSON.stringify(
          entry,
        )}. Each entry must be a single CSP source-list value (e.g. "https://api.example.com").`,
      );
    }
    return entry;
  });
  const connectSrc = ["'self'", "ws:", "wss:", ...allowlist].join(" ");
  // style-src deliberately omits the nonce. Per CSP spec, when a nonce
  // is present in style-src, `'unsafe-inline'` is ignored — which would
  // block every React `style={{...}}` inline emission. Nonce-on-style
  // is impractical for any React app; we keep `'unsafe-inline'` and
  // accept the trade-off. script-src remains nonce-protected.
  //
  // frame-ancestors deliberately omitted: browsers ignore it when
  // delivered via <meta>; it must be sent as a response header. The
  // hosting layer (apps/api / static-host config / Vercel) is
  // responsible for emitting `Content-Security-Policy: frame-ancestors
  // 'none'` (or similar) at the response level.
  const directives: ReadonlyArray<readonly [string, string]> = [
    ["default-src", "'self'"],
    ["script-src", `'self' 'nonce-${nonce}'`],
    ["style-src", "'self' 'unsafe-inline'"],
    ["img-src", "'self' data: blob: https:"],
    ["font-src", "'self' data:"],
    ["connect-src", connectSrc],
    ["worker-src", "'self' blob:"],
    ["manifest-src", "'self'"],
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'"],
  ];
  return directives.map(([k, v]) => `${k} ${v}`).join("; ") + ";";
}

type NormalizedBg = { light: string; dark: string | null };

// Coerce the public `SplashBackgroundColor` into a normalized pair. Single
// strings produce `dark: null` so the emit path can detect "no dark mode
// requested" and skip the boot-theme script + dark CSS rules entirely.
function normalizeBackground(
  value: SplashBackgroundColor | undefined,
): NormalizedBg {
  if (value === undefined) return { light: DEFAULT_BG, dark: null };
  if (typeof value === "string") return { light: value, dark: null };
  return { light: value.light, dark: value.dark };
}

function buildResetCss(bg: NormalizedBg): string {
  // Critical CSS, inlined so the rules apply at first paint — before the
  // bundle, before React. Conforms to the mobile-app PWA guidelines:
  //   - Hex `background-color` on <html> and <body> (iOS can't parse oklch)
  //   - body min-height: 100dvh (dynamic viewport, iOS-correct)
  //   - overscroll-behavior: none — kills rubber-band on installed PWAs
  //   - viewport-fit=cover (in <meta>) + safe-area-inset CSS variables
  //     exposed for app code to consume
  //   - 16px input font-size to prevent iOS Safari focus zoom
  //   - touch-action: manipulation on interactive elements (no 300ms click)
  //   - -webkit-tap-highlight-color transparent (no grey flash)
  //   - text-rendering: optimizeLegibility for native-feel typography
  //
  // When `bg.dark` is set, we emit dark overrides keyed on BOTH common
  // conventions (`html.dark` from Tailwind/shadcn and
  // `html[data-theme="dark"]` from next-themes) plus a
  // `prefers-color-scheme: dark` fallback that fires when the user has
  // never set a persisted theme. The boot-theme script applies the right
  // class/attribute synchronously based on `localStorage` so the
  // persisted-choice rules dominate.
  const lightBlock = `
:root {
  --crucible-safe-top: env(safe-area-inset-top, 0px);
  --crucible-safe-right: env(safe-area-inset-right, 0px);
  --crucible-safe-bottom: env(safe-area-inset-bottom, 0px);
  --crucible-safe-left: env(safe-area-inset-left, 0px);
}
*,*::before,*::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
html {
  background-color: ${bg.light};
  -webkit-text-size-adjust: 100%;
  text-rendering: optimizeLegibility;
}
body {
  min-height: 100dvh;
  background-color: ${bg.light};
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  -webkit-tap-highlight-color: transparent;
  overscroll-behavior: none;
  overflow-x: hidden;
}
button, a, [role="button"] {
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
input:not([type="range"]), select, textarea { font-size: 16px; }
#root {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
}
#${SPLASH_ID} {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  background-color: ${bg.light};
  /* Safe-area padding keeps splash CONTENT clear of the status bar and
     home indicator on installed iOS PWAs. Background still fills full
     bleed because of viewport-fit=cover + position: fixed. */
  padding: var(--crucible-safe-top) var(--crucible-safe-right) var(--crucible-safe-bottom) var(--crucible-safe-left);
  opacity: 1;
  transition: opacity ${FADE_MS}ms ease-out;
  pointer-events: auto;
}
#${SPLASH_ID}.${SPLASH_HIDDEN_CLASS} {
  opacity: 0;
  pointer-events: none;
}
`;
  if (!bg.dark) return lightBlock;

  // Dark overrides. Keyed three ways so the splash respects whichever
  // surface advertises dark mode first:
  //
  //   1. `html.dark` — Tailwind v4 / shadcn convention. The boot script
  //      stamps this class when `themeStorage.attribute === "class"` and
  //      the persisted choice is dark.
  //   2. `html[data-theme="dark"]` — next-themes default attribute. The
  //      boot script stamps this when `themeStorage.attribute === "data-theme"`.
  //   3. `@media (prefers-color-scheme: dark)` — covers system preference
  //      when the user has never set a persisted choice. Wrapped in
  //      `:not(.light):not([data-theme="light"])` so an explicit "light"
  //      choice still wins on a dark-OS device.
  const dark = bg.dark;
  return `${lightBlock}
html.dark, html.dark body, html.dark #${SPLASH_ID} {
  background-color: ${dark};
}
html[data-theme="dark"], html[data-theme="dark"] body, html[data-theme="dark"] #${SPLASH_ID} {
  background-color: ${dark};
}
@media (prefers-color-scheme: dark) {
  html:not(.light):not([data-theme="light"]),
  html:not(.light):not([data-theme="light"]) body,
  html:not(.light):not([data-theme="light"]) #${SPLASH_ID} {
    background-color: ${dark};
  }
}
`;
}

// Boot-theme script: runs synchronously at the top of <head>, BEFORE the
// browser paints the splash. Reads `localStorage[storageKey]` (set by the
// runtime ThemeProvider — next-themes, shadcn's hand-rolled provider, or
// any compatible writer), falls back to `prefers-color-scheme` for users
// who have never set a persisted choice, and stamps the right class /
// attribute on `<html>` so the dark-mode CSS rules in `buildResetCss`
// pick the right color.
//
// The script is wrapped in a try/catch so a Safari Private-Mode
// localStorage-throws path falls back to the system preference instead
// of crashing the page. The try-block reads `light` / `dark` / `system`
// (the values next-themes documents); any other value collapses to
// `system` so unknown writers degrade gracefully.
function buildBootThemeScript(storage: ThemeStorage): string {
  if (/[\s'"\\;]/.test(storage.storageKey)) {
    throw new Error(
      `[crucible] themeStorage.storageKey contains a forbidden character: ${JSON.stringify(
        storage.storageKey,
      )}. Use a plain alphanumeric/dash key (e.g. "theme", "vite-ui-theme").`,
    );
  }
  const key = storage.storageKey;
  if (storage.attribute === "class") {
    return `(function(){try{var k=${JSON.stringify(key)};var v=null;try{v=localStorage.getItem(k);}catch(_){}if(v!=="light"&&v!=="dark"&&v!=="system"&&v!==null)v="system";var d=v==="dark"||((v==="system"||v===null)&&window.matchMedia("(prefers-color-scheme: dark)").matches);var c=document.documentElement.classList;c.remove("light","dark");c.add(d?"dark":"light");}catch(e){}})();`;
  }
  return `(function(){try{var k=${JSON.stringify(key)};var v=null;try{v=localStorage.getItem(k);}catch(_){}if(v!=="light"&&v!=="dark"&&v!=="system"&&v!==null)v="system";var d=v==="dark"||((v==="system"||v===null)&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.setAttribute("data-theme",d?"dark":"light");}catch(e){}})();`;
}

type LoadedSplash = {
  html: string;
  beforeMountSnippets: ReadonlyArray<string>;
};

async function loadSplashIfPresent(
  appRoot: string,
): Promise<LoadedSplash | null> {
  const candidate = join(appRoot, "src", "app", "splash.tsx");
  if (!existsSync(candidate)) return null;
  installCodegenGlobals();
  let html: string;
  try {
    const mod = await import(
      `${pathToFileURL(candidate).href}?t=${Date.now()}`
    );
    const Component = mod.default;
    if (typeof Component !== "function") {
      console.warn(
        `[crucible] ${candidate} must export a default React component.`,
      );
      return null;
    }
    html = renderToStaticMarkup(createElement(Component));
  } catch (err) {
    console.error(
      `[crucible] failed to render src/app/splash.tsx:`,
      err,
    );
    return null;
  }
  const beforeMountSnippets = extractBeforeMountCalls(candidate);
  return { html, beforeMountSnippets };
}

// Parse splash.tsx and pull out every top-level `beforeCrucibleMount(...)`
// callback as TS-stripped JS source.
const MACRO_NAME = "beforeCrucibleMount";

function extractBeforeMountCalls(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const snippets: string[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isExpressionStatement(stmt)) continue;
    if (!ts.isCallExpression(stmt.expression)) continue;
    const callee = stmt.expression.expression;
    if (!ts.isIdentifier(callee) || callee.text !== MACRO_NAME) continue;
    const arg = stmt.expression.arguments[0];
    if (!arg) continue;
    const argSource = source.slice(arg.getStart(sf), arg.getEnd());
    snippets.push(stripTsTypes(argSource));
  }
  return snippets;
}

// Wraps the user's `beforeCrucibleMount` callback as a complete IIFE
// statement and TS-strips with Bun's transpiler. The output is ready to
// inline as `<script>` content — no post-processing of trailing
// semicolons or stripped wrap markers. We wrap BEFORE transpile so the
// transpiler sees a known-complete statement; trying to peel back the
// wrap after transpile is fragile (TS / Bun output may inject prologues
// or restructure the expression).
function stripTsTypes(snippet: string): string {
  const transpiler = new Bun.Transpiler({ loader: "tsx" });
  return transpiler.transformSync(`(${snippet})();`).trim();
}

// HTML encoding for text content + double-quoted attribute values, per
// OWASP "Cross Site Scripting Prevention Cheat Sheet" — Output Encoding
// Rules Summary (Rules #1 and #2).
//
//   &  →  &amp;     (must be FIRST; later replacements would re-encode it)
//   <  →  &lt;
//   >  →  &gt;
//   "  →  &quot;
//   '  →  &#39;     (numeric ref, not &apos;: works in HTML4 and HTML5)
//
// `&apos;` is HTML5/XML only; `&#39;` is the universal escape for the
// apostrophe and what OWASP recommends. Encoding the apostrophe is
// defense-in-depth: it makes the output safe in single-quoted attribute
// contexts too, even though our templates currently use only double
// quotes. If a future template adds a `<x attr='${escapeHtml(...)}'>`
// callsite, this escape keeps it XSS-free without a code change there.
//
// Reference: https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Install no-op stubs on `globalThis` before dynamic-importing user files
// at codegen time. The user authors with no `crucible` module imports —
// `beforeCrucibleMount`, `defineManifest`, the `Manifest` type are all
// global ambients (see plugin/crucible-env.d.ts). At evaluation time these
// stubs let the call sites no-op without ReferenceError; the codegen
// extracts the real data via TS AST in a separate pass, not by trapping
// these calls.
let stubsInstalled = false;
export function installCodegenGlobals(): void {
  if (stubsInstalled) return;
  const g = globalThis as Record<string, unknown>;
  if (typeof g.beforeCrucibleMount !== "function") {
    g.beforeCrucibleMount = () => {};
  }
  if (typeof g.defineManifest !== "function") {
    g.defineManifest = (manifest: unknown) => manifest;
  }
  stubsInstalled = true;
}

// Best-effort title/themeColor extraction from the root layout's metadata
// export. Cheap regex; covers the common shapes.
export function extractRootLayoutTitle(appRoot: string): string | undefined {
  const text = readLayoutText(appRoot);
  if (!text) return undefined;
  const direct = /metadata[^=]*=\s*\{[\s\S]*?title\s*:\s*["'`]([^"'`]+)["'`]/m.exec(
    text,
  );
  if (direct) return direct[1];
  const template =
    /metadata[^=]*=\s*\{[\s\S]*?title\s*:\s*\{[\s\S]*?default\s*:\s*["'`]([^"'`]+)["'`]/m.exec(
      text,
    );
  if (template) return template[1];
  return undefined;
}

export function extractRootLayoutThemeColor(
  appRoot: string,
): string | undefined {
  const text = readLayoutText(appRoot);
  if (!text) return undefined;
  const m = /metadata[^=]*=\s*\{[\s\S]*?themeColor\s*:\s*["'`](#[0-9a-fA-F]{3,8})["'`]/m.exec(
    text,
  );
  return m?.[1];
}

// Best-effort `backgroundColor` extraction from the root layout's metadata
// export. Recognizes both the single-string form and the object form
// (`{ light: "#fff", dark: "#0a0a0a" }`). Returns `undefined` when
// neither matches; callers fall back to `DEFAULT_BG`.
//
// Cheap regex parse — matches the existing `extractRootLayoutTitle` /
// `extractRootLayoutThemeColor` strategy. Full TS parsing here would
// mean dynamic-importing the layout, which pulls every transitive
// import into the codegen process.
export function extractRootLayoutBackgroundColor(
  appRoot: string,
): SplashBackgroundColor | undefined {
  const text = readLayoutText(appRoot);
  if (!text) return undefined;
  const objMatch =
    /metadata[^=]*=\s*\{[\s\S]*?backgroundColor\s*:\s*\{\s*light\s*:\s*["'`](#[0-9a-fA-F]{3,8})["'`]\s*,\s*dark\s*:\s*["'`](#[0-9a-fA-F]{3,8})["'`]\s*\}/m.exec(
      text,
    );
  if (objMatch) return { light: objMatch[1]!, dark: objMatch[2]! };
  const single =
    /metadata[^=]*=\s*\{[\s\S]*?backgroundColor\s*:\s*["'`](#[0-9a-fA-F]{3,8})["'`]/m.exec(
      text,
    );
  return single?.[1];
}

function readLayoutText(appRoot: string): string | undefined {
  const layoutPath = join(appRoot, "src", "app", "layout.tsx");
  if (!existsSync(layoutPath)) return undefined;
  try {
    return readFileSync(layoutPath, "utf8");
  } catch {
    return undefined;
  }
}

void dirname;

export const SPLASH_DOM = {
  id: SPLASH_ID,
  hiddenClass: SPLASH_HIDDEN_CLASS,
  fadeMs: FADE_MS,
  mountedEvent: "crucible:mounted",
};
