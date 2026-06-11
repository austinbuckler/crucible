// URL safety has two distinct concerns. Don't conflate them.
//
//   1. Render in an <a href="…"> attribute. The threat is XSS via
//      `javascript:` / `data:` / `vbscript:` / `file:`. The browser handles
//      cross-origin clicks natively, so cross-origin http(s) is fine in
//      href — middle-click, cmd-click, and right-click → open-in-new-tab
//      all go through the browser, not the router.
//
//   2. Hand to the router (navigate / prefetch). The threat is `pushState`
//      throwing on cross-origin URLs and `prefetch` wasting network
//      requests against attacker-controlled paths that happen to match a
//      route by pathname. Cross-origin must be REJECTED here even if it's
//      scheme-safe.
//
// Use `isSafeHref` for #1, `isRouterTarget` for #2.

const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

const UNSAFE_SCHEME_RE = /^(javascript|data|vbscript|file):/i;

function defaultBase(): string {
  return typeof window !== "undefined" ? window.location.href : "http://localhost/";
}

function isRelativeOrFragment(trimmed: string): boolean {
  return (
    trimmed.startsWith("/") ||
    trimmed.startsWith("?") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith(".")
  );
}

// Returns true when `to` is safe to render as an <a href="…"> attribute.
// Accepts:
//  - relative URLs (start with `/`, `?`, `#`, `.`)
//  - same-origin and cross-origin `http(s)`
//  - `mailto:` / `tel:`
//
// Cross-origin http(s) IS safe to render — the browser handles the click
// natively. But it's NOT safe to hand to the router; use `isRouterTarget`
// for that decision.
export function isSafeHref(to: unknown, base: string = defaultBase()): boolean {
  if (typeof to !== "string") return false;
  const trimmed = to.trim();
  if (trimmed === "") return false;
  if (UNSAFE_SCHEME_RE.test(trimmed)) return false;
  if (isRelativeOrFragment(trimmed)) return true;
  let url: URL;
  try {
    url = new URL(trimmed, base);
  } catch {
    return false;
  }
  return SAFE_SCHEMES.has(url.protocol);
}

// Returns true when `to` is a router target — same-origin or relative.
// Cross-origin URLs return false even when scheme-safe, because
// `history.pushState` throws on cross-origin and `prefetch` would waste
// network requests against unrelated paths. mailto: and tel: are also
// rejected here — those are href-only, not navigable.
export function isRouterTarget(
  to: unknown,
  base: string = defaultBase(),
): boolean {
  if (typeof to !== "string") return false;
  const trimmed = to.trim();
  if (trimmed === "") return false;
  if (UNSAFE_SCHEME_RE.test(trimmed)) return false;
  if (isRelativeOrFragment(trimmed)) return true;
  let url: URL;
  try {
    url = new URL(trimmed, base);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
  } catch {
    return false;
  }
  return url.origin === baseUrl.origin;
}

export function assertRouterTarget(to: string): void {
  if (!isRouterTarget(to)) {
    throw new Error(
      `[crucible] Refusing to route to "${to}". Only same-origin and relative paths are routable; cross-origin links should open via the browser.`,
    );
  }
}
