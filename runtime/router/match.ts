import type { Match, RouteRecord } from "./types.ts";

// `matchRoute` finds the FIRST exact-URL match. Routes are linear-scanned
// in array order — codegen emits them in the order pages are discovered
// on disk, which is stable and deterministic.
//
// Decoding is wrapped: `decodeURIComponent("%E0%A4")` throws on malformed
// percent-encoding. The router treats malformed inputs as "no match"
// rather than crashing the render.
export function matchRoute(
  routes: ReadonlyArray<RouteRecord>,
  pathname: string,
): Match | null {
  const parts = pathname.split("/").filter(Boolean);
  outer: for (const route of routes) {
    const params: Record<string, string> = {};
    let i = 0;
    for (const seg of route.segments) {
      if (seg.kind === "catchall") {
        params[seg.name] = parts.slice(i).join("/");
        i = parts.length;
        break;
      }
      if (i >= parts.length) continue outer;
      if (seg.kind === "literal") {
        if (seg.value !== parts[i]) continue outer;
      } else {
        try {
          params[seg.name] = decodeURIComponent(parts[i]!);
        } catch {
          continue outer;
        }
      }
      i++;
    }
    if (i !== parts.length) continue;
    return { route, params };
  }
  return null;
}

// `matchDefault` matches as a URL PREFIX — the route's segments must
// align with the leading parts of `pathname`, but the URL may extend
// further. Caller passes `defaults` sorted deepest-first so the closest
// ancestor wins when multiple defaults cover the URL.
export function matchDefault(
  defaults: ReadonlyArray<RouteRecord>,
  pathname: string,
): Match | null {
  const parts = pathname.split("/").filter(Boolean);
  outer: for (const route of defaults) {
    const params: Record<string, string> = {};
    let i = 0;
    for (const seg of route.segments) {
      if (seg.kind === "catchall") {
        params[seg.name] = parts.slice(i).join("/");
        return { route, params };
      }
      if (i >= parts.length) continue outer;
      if (seg.kind === "literal") {
        if (seg.value !== parts[i]) continue outer;
      } else {
        try {
          params[seg.name] = decodeURIComponent(parts[i]!);
        } catch {
          continue outer;
        }
      }
      i++;
    }
    return { route, params };
  }
  return null;
}

// Matcher strategy type. The default is `matchRoute`; consumers can pass
// a custom matcher to `<App matcher={...} />` for advanced URL-shape
// handling (e.g. case-insensitive, locale-prefix-aware). Strategy
// shape, not a class — easier to compose.
export type MatchFn = (
  routes: ReadonlyArray<RouteRecord>,
  pathname: string,
) => Match | null;
