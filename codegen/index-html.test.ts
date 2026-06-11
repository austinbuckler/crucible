import { test, expect, describe } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCsp,
  escapeHtml,
  emitIndexHtml,
  extractRootLayoutBackgroundColor,
} from "./index-html.ts";

describe("escapeHtml — OWASP cheatsheet rules #1 and #2", () => {
  // Reference:
  // https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html

  test("each of the five OWASP-required characters is escaped", () => {
    expect(escapeHtml("&")).toBe("&amp;");
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml(">")).toBe("&gt;");
    expect(escapeHtml('"')).toBe("&quot;");
    expect(escapeHtml("'")).toBe("&#39;");
  });

  test("apostrophe uses numeric ref (HTML4-safe), not &apos;", () => {
    // &apos; is HTML5/XML-only. Numeric ref works everywhere.
    expect(escapeHtml("'")).toBe("&#39;");
    expect(escapeHtml("'")).not.toBe("&apos;");
  });

  test("composed input — every replacement applied", () => {
    expect(escapeHtml(`<a href="x" rel='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; rel=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });

  test("ampersand is escaped first (idempotent text content)", () => {
    // Input that already looks escaped — our escape MUST treat the leading
    // & as a literal and re-escape it, so `&lt;` becomes `&amp;lt;`. Any
    // other order would leave double-escaping bugs on round-trip.
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });

  test("leaves safe content untouched", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
    expect(escapeHtml("")).toBe("");
    expect(escapeHtml("a-b_c.d/e:f")).toBe("a-b_c.d/e:f");
  });

  test("after escape, output contains no raw HTML-significant char", () => {
    // Property: feeding ANY input through escapeHtml must produce a string
    // with zero raw <, >, ", ', or & (all are encoded). One canary input
    // covers the five-char attack surface.
    const canaries = [
      "</script><img src=x onerror=alert(1)>",
      "\"><svg onload=alert(1)>",
      "'-alert(1)-'",
      "&\"<>'",
    ];
    for (const input of canaries) {
      const out = escapeHtml(input);
      expect(out).not.toMatch(/[<>"']/);
      // `&` is allowed in output ONLY as part of an entity. Verify all
      // ampersands are followed by a valid entity start.
      const ampersands = (out.match(/&/g) || []).length;
      const entities = (out.match(/&(amp|lt|gt|quot|#\d+);/g) || []).length;
      expect(ampersands).toBe(entities);
    }
  });
});

describe("buildCsp", () => {
  test("includes nonce-based script-src and excludes 'unsafe-inline' from script-src", () => {
    const csp = buildCsp("ABC123");
    expect(csp).toContain("script-src 'self' 'nonce-ABC123'");
    // The whole point of nonce-based CSP: scripts need the nonce, not
    // 'unsafe-inline'. If an XSS injection lands without our nonce, the
    // browser blocks execution.
    const scriptSrcSection = csp.match(/script-src[^;]+/)?.[0] ?? "";
    expect(scriptSrcSection).not.toContain("'unsafe-inline'");
  });

  test("style-src omits the nonce (would invalidate 'unsafe-inline' which React needs)", () => {
    const csp = buildCsp("XYZ");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    // Nonce in style-src would block every React inline style per CSP
    // spec ("'unsafe-inline' is ignored if a nonce is present").
    const styleSrcMatch = csp.match(/style-src ([^;]+);/);
    expect(styleSrcMatch?.[1]).not.toContain("nonce-");
  });

  test("hardens defaults: object-src none, base-uri self", () => {
    const csp = buildCsp("nonce");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
  });

  test("frame-ancestors omitted from <meta> CSP (browsers ignore it there; must be a response header)", () => {
    const csp = buildCsp("nonce");
    expect(csp).not.toContain("frame-ancestors");
  });

  test("connect-src defaults to 'self' + ws/wss only (no wildcard http/https)", () => {
    const csp = buildCsp("nonce");
    expect(csp).toContain("connect-src 'self' ws: wss:;");
    // The previous wide-open default leaked exfiltration paths via any
    // compromised dep. Make sure we don't regress to it.
    const connectSection = csp.match(/connect-src[^;]+/)?.[0] ?? "";
    expect(connectSection).not.toContain("http:");
    expect(connectSection).not.toContain("https:");
  });

  test("connect-src appends entries from connectSrcAllowlist verbatim", () => {
    const csp = buildCsp("nonce", {
      connectSrcAllowlist: [
        "https://api.example.com",
        "https://*.sentry.io",
      ],
    });
    expect(csp).toContain(
      "connect-src 'self' ws: wss: https://api.example.com https://*.sentry.io;",
    );
  });

  test("empty connectSrcAllowlist matches the no-arg default", () => {
    expect(buildCsp("nonce", { connectSrcAllowlist: [] })).toBe(
      buildCsp("nonce"),
    );
  });

  test("rejects connectSrcAllowlist entries containing ';' (CSP-directive smuggling)", () => {
    // A value containing `;` would close the directive and inject a new
    // one — e.g. "https://x.com; script-src *" would unlock script-src.
    // Build-time fail-fast keeps a future config-from-env path safe.
    expect(() =>
      buildCsp("n", {
        connectSrcAllowlist: ["https://x.com; script-src *"],
      }),
    ).toThrow(/semicolon/);
  });

  test("rejects connectSrcAllowlist entries containing whitespace", () => {
    expect(() =>
      buildCsp("n", { connectSrcAllowlist: ["https://x.com bad"] }),
    ).toThrow(/whitespace/);
    expect(() =>
      buildCsp("n", { connectSrcAllowlist: ["https://x.com\t"] }),
    ).toThrow(/whitespace/);
  });

  test("ends with semicolon (some parsers require terminator)", () => {
    expect(buildCsp("x").trim().endsWith(";")).toBe(true);
  });

  test("different nonces produce different CSPs", () => {
    expect(buildCsp("a")).not.toBe(buildCsp("b"));
  });
});

describe("emitIndexHtml — output shape", () => {
  function freshAppRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "crucible-html-"));
    mkdirSync(join(dir, "src", "app"), { recursive: true });
    return dir;
  }

  test("emits .crucible/index.html with required tags", async () => {
    const appRoot = freshAppRoot();
    await emitIndexHtml({ appRoot });
    const out = readFileSync(join(appRoot, ".crucible", "index.html"), "utf8");
    expect(out).toContain("<!doctype html>");
    expect(out).toContain('<div id="root"></div>');
    expect(out).toContain('<script type="module"');
    expect(out).toContain("./main.tsx");
    expect(out).toContain("Content-Security-Policy");
    // Nonce must be stamped on the bootstrapping module script.
    expect(out).toMatch(/<script type="module" nonce="[^"]+"/);
  });

  test("nonce in CSP matches nonce on inline tags", async () => {
    const appRoot = freshAppRoot();
    await emitIndexHtml({ appRoot });
    const out = readFileSync(join(appRoot, ".crucible", "index.html"), "utf8");
    // Extract from the script tag (double-quoted, not touched by escapeHtml).
    // The meta-tag content is HTML-escaped, so single quotes appear as
    // `&#39;` — the browser un-escapes those before CSP parsing, which is
    // why both forms are equivalent at runtime.
    const scriptNonce = /<script type="module" nonce="([^"]+)"/.exec(out)?.[1];
    expect(scriptNonce).toBeTruthy();
    // CSP meta value carries the same nonce, just HTML-encoded.
    expect(out).toContain(`&#39;nonce-${scriptNonce}&#39;`);
  });

  test("renders splash and stamps nonce on the inline dismiss tag when splash.tsx exists", async () => {
    const appRoot = freshAppRoot();
    writeFileSync(
      join(appRoot, "src", "app", "splash.tsx"),
      `export default function Splash() { return null; }`,
      "utf8",
    );
    await emitIndexHtml({ appRoot });
    const out = readFileSync(join(appRoot, ".crucible", "index.html"), "utf8");
    expect(out).toContain('id="crucible-splash"');
    // The default dismiss listener must carry the nonce.
    expect(out).toMatch(/<script nonce="[^"]+">[^<]*crucible:mounted/);
  });

  test("escapes hostile fallback title", async () => {
    const appRoot = freshAppRoot();
    const hostile = "</title><b>x</b>";
    await emitIndexHtml({ appRoot, fallbackTitle: hostile });
    const out = readFileSync(join(appRoot, ".crucible", "index.html"), "utf8");
    expect(out).not.toContain(hostile);
    expect(out).toContain("&lt;/title&gt;&lt;b&gt;x&lt;/b&gt;");
  });

  test("threads connectSrcAllowlist into the emitted CSP meta tag", async () => {
    const appRoot = freshAppRoot();
    await emitIndexHtml({
      appRoot,
      connectSrcAllowlist: ["https://api.example.com"],
    });
    const out = readFileSync(join(appRoot, ".crucible", "index.html"), "utf8");
    expect(out).toContain(
      "connect-src &#39;self&#39; ws: wss: https://api.example.com;",
    );
  });

  test("default emit produces a tight connect-src (no http:/https: wildcards)", async () => {
    const appRoot = freshAppRoot();
    await emitIndexHtml({ appRoot });
    const out = readFileSync(join(appRoot, ".crucible", "index.html"), "utf8");
    expect(out).toContain("connect-src &#39;self&#39; ws: wss:;");
    const metaMatch = /content="([^"]*connect-src[^;]+;)/.exec(out);
    const metaConnect = metaMatch?.[1] ?? "";
    expect(metaConnect).not.toMatch(/connect-src[^;]*\bhttp:/);
    expect(metaConnect).not.toMatch(/connect-src[^;]*\bhttps:/);
  });

  test("each emit produces a fresh nonce", async () => {
    const appRoot = freshAppRoot();
    await emitIndexHtml({ appRoot });
    const a = readFileSync(join(appRoot, ".crucible", "index.html"), "utf8");
    await emitIndexHtml({ appRoot });
    const b = readFileSync(join(appRoot, ".crucible", "index.html"), "utf8");
    const nonceA = /<script type="module" nonce="([^"]+)"/.exec(a)?.[1];
    const nonceB = /<script type="module" nonce="([^"]+)"/.exec(b)?.[1];
    expect(nonceA).toBeTruthy();
    expect(nonceB).toBeTruthy();
    expect(nonceA).not.toBe(nonceB);
  });
});

describe("emitIndexHtml — splash background color", () => {
  function freshAppRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "crucible-html-bg-"));
    mkdirSync(join(dir, "src", "app"), { recursive: true });
    return dir;
  }

  test("single-string `fallbackBackgroundColor` applies to the splash + body in BOTH modes (no boot script, no dark CSS)", async () => {
    const appRoot = freshAppRoot();
    await emitIndexHtml({ appRoot, fallbackBackgroundColor: "#abcdef" });
    const out = readFileSync(join(appRoot, ".crucible", "index.html"), "utf8");
    expect(out).toContain("background-color: #abcdef");
    // No dark-mode CSS rules should be emitted for the single-color form —
    // they'd just bloat the inline style with no effect.
    expect(out).not.toContain("html.dark");
    expect(out).not.toContain("prefers-color-scheme: dark");
    // No boot-theme script when the splash has only one color.
    expect(out).not.toContain('localStorage.getItem');
  });

  test("dual-form `fallbackBackgroundColor` emits per-mode CSS rules + boot-theme script", async () => {
    const appRoot = freshAppRoot();
    await emitIndexHtml({
      appRoot,
      fallbackBackgroundColor: { light: "#ffffff", dark: "#0a0a0a" },
    });
    const out = readFileSync(join(appRoot, ".crucible", "index.html"), "utf8");
    // Light is the always-on default.
    expect(out).toContain("background-color: #ffffff");
    // Dark overrides keyed on BOTH the Tailwind/shadcn class convention
    // and the next-themes data-attribute convention so apps using either
    // wiring get the right color without touching Crucible.
    expect(out).toContain("html.dark");
    expect(out).toContain('html[data-theme="dark"]');
    expect(out).toContain("background-color: #0a0a0a");
    // System-preference fallback covers users with no persisted choice.
    expect(out).toContain("@media (prefers-color-scheme: dark)");
    // Boot-theme script must be present, must read localStorage, and must
    // carry the build's CSP nonce.
    expect(out).toMatch(/<script nonce="[^"]+">[^<]*localStorage\.getItem/);
  });

  test("boot-theme script reads the configured storage key and applies the class convention by default", async () => {
    const appRoot = freshAppRoot();
    await emitIndexHtml({
      appRoot,
      fallbackBackgroundColor: { light: "#fff", dark: "#000" },
      themeStorage: { storageKey: "vite-ui-theme", attribute: "class" },
    });
    const out = readFileSync(join(appRoot, ".crucible", "index.html"), "utf8");
    expect(out).toContain('"vite-ui-theme"');
    // Class convention: classList.add("dark"|"light"). data-theme attribute
    // path should NOT fire when class strategy is selected.
    expect(out).toContain("classList");
    expect(out).not.toContain('setAttribute("data-theme"');
  });

  test("boot-theme script writes data-theme attribute when configured", async () => {
    const appRoot = freshAppRoot();
    await emitIndexHtml({
      appRoot,
      fallbackBackgroundColor: { light: "#fff", dark: "#000" },
      themeStorage: { storageKey: "theme", attribute: "data-theme" },
    });
    const out = readFileSync(join(appRoot, ".crucible", "index.html"), "utf8");
    expect(out).toContain('setAttribute("data-theme"');
    expect(out).not.toContain("classList.add");
  });

  test("boot-theme script falls back to prefers-color-scheme when localStorage is unset", async () => {
    // The script must compute `dark` for a user who has never persisted
    // a choice but whose OS reports `prefers-color-scheme: dark`. We
    // pin the matchMedia call so a future refactor can't drop it.
    const appRoot = freshAppRoot();
    await emitIndexHtml({
      appRoot,
      fallbackBackgroundColor: { light: "#fff", dark: "#000" },
    });
    const out = readFileSync(join(appRoot, ".crucible", "index.html"), "utf8");
    expect(out).toContain('matchMedia("(prefers-color-scheme: dark)")');
  });

  test("boot-theme script swallows localStorage exceptions (Safari Private Mode)", async () => {
    // Private-Mode Safari historically threw on localStorage access. The
    // boot script wraps the read in try/catch so the splash still paints
    // (using prefers-color-scheme) instead of throwing pre-mount.
    const appRoot = freshAppRoot();
    await emitIndexHtml({
      appRoot,
      fallbackBackgroundColor: { light: "#fff", dark: "#000" },
    });
    const out = readFileSync(join(appRoot, ".crucible", "index.html"), "utf8");
    // Two try blocks: outer guards the whole script, inner guards the
    // localStorage call. The inner one is what protects Private Mode.
    expect(out).toMatch(/try\s*\{\s*v\s*=\s*localStorage/);
  });

  test("dual-form `fallbackBackgroundColor` falls back to light for the OS chrome `theme-color` meta", async () => {
    // `<meta name="theme-color">` is hex-only and pre-paint — there's
    // no per-mode form the browser respects. Pick the light value as
    // the canonical default; consumers can override via
    // `fallbackThemeColor`.
    const appRoot = freshAppRoot();
    await emitIndexHtml({
      appRoot,
      fallbackBackgroundColor: { light: "#ffffff", dark: "#0a0a0a" },
    });
    const out = readFileSync(join(appRoot, ".crucible", "index.html"), "utf8");
    expect(out).toContain('<meta name="theme-color" content="#ffffff"');
  });

  test("explicit `fallbackThemeColor` overrides the chrome color independently of the splash bg", async () => {
    const appRoot = freshAppRoot();
    await emitIndexHtml({
      appRoot,
      fallbackBackgroundColor: { light: "#ffffff", dark: "#0a0a0a" },
      fallbackThemeColor: "#123456",
    });
    const out = readFileSync(join(appRoot, ".crucible", "index.html"), "utf8");
    expect(out).toContain('<meta name="theme-color" content="#123456"');
  });

  test("rejects storage keys with characters that would break the inlined JS literal", async () => {
    // The script JSON-stringifies the key, but a future refactor that
    // forgot to do so would let a key like `; alert(1)` smuggle code
    // into the boot script. Validate at codegen time so regressions
    // fail fast.
    const appRoot = freshAppRoot();
    await expect(
      emitIndexHtml({
        appRoot,
        fallbackBackgroundColor: { light: "#fff", dark: "#000" },
        themeStorage: { storageKey: "bad; alert(1)", attribute: "class" },
      }),
    ).rejects.toThrow(/forbidden character/);
  });

  test("default emit (no `fallbackBackgroundColor`) still produces a working white splash (no regression)", async () => {
    const appRoot = freshAppRoot();
    await emitIndexHtml({ appRoot });
    const out = readFileSync(join(appRoot, ".crucible", "index.html"), "utf8");
    // The pre-existing default (#ffffff) still fills <html>, <body>, and
    // the splash overlay.
    expect(out).toContain("background-color: #ffffff");
    expect(out).not.toContain("html.dark");
  });
});

describe("extractRootLayoutBackgroundColor", () => {
  function freshAppRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "crucible-extract-"));
    mkdirSync(join(dir, "src", "app"), { recursive: true });
    return dir;
  }

  test("recognizes single-string form", () => {
    const appRoot = freshAppRoot();
    writeFileSync(
      join(appRoot, "src", "app", "layout.tsx"),
      `export const metadata = { title: "X", backgroundColor: "#ffffff" };
export default function Layout({ children }) { return children; }`,
      "utf8",
    );
    expect(extractRootLayoutBackgroundColor(appRoot)).toBe("#ffffff");
  });

  test("recognizes dual-form `{ light, dark }`", () => {
    const appRoot = freshAppRoot();
    writeFileSync(
      join(appRoot, "src", "app", "layout.tsx"),
      `export const metadata = {
  title: "X",
  backgroundColor: { light: "#ffffff", dark: "#0a0a0a" },
};
export default function Layout({ children }) { return children; }`,
      "utf8",
    );
    expect(extractRootLayoutBackgroundColor(appRoot)).toEqual({
      light: "#ffffff",
      dark: "#0a0a0a",
    });
  });

  test("returns undefined when layout has no metadata.backgroundColor", () => {
    const appRoot = freshAppRoot();
    writeFileSync(
      join(appRoot, "src", "app", "layout.tsx"),
      `export const metadata = { title: "X" };
export default function Layout({ children }) { return children; }`,
      "utf8",
    );
    expect(extractRootLayoutBackgroundColor(appRoot)).toBeUndefined();
  });

  test("returns undefined when no layout.tsx is present", () => {
    const appRoot = freshAppRoot();
    expect(extractRootLayoutBackgroundColor(appRoot)).toBeUndefined();
  });
});
