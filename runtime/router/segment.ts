import type { Match, RouteSegment } from "./types.ts";

// Reduce a `RouteSegment` to the string the URL exposes. Literals return
// their literal value; param/catchall segments need the bound value from
// the match, so callers pass `params` and the kind decides which lookup
// to do.
//
// Mirrors Next.js's `getSegmentValue` (segment.js:51) for parallel-route
// awareness — Crucible's segments don't carry an array form, so we use
// the kind tag instead. Returns `null` if the segment can't be reduced
// (e.g. a missing param), but in practice Crucible's matcher always
// binds every param before producing a `Match`.
export function segmentValue(
  seg: RouteSegment,
  params: Record<string, string>,
): string | null {
  if (seg.kind === "literal") return seg.value;
  if (seg.kind === "param") return params[seg.name] ?? null;
  return params[seg.name] ?? null;
}

// `useSelectedLayoutSegment` for the calling layout's main outlet. The
// layout sits at `urlDepth` URL segments deep — its `children` slot
// renders the segment at index `urlDepth` in the active match. When the
// active match is shallower than the layout (i.e. no descendant page is
// active under it) returns `null`, matching Next.js semantics.
//
// Cited: node_modules/.bun/next@16.1.1+.../next/dist/shared/lib/segment.js:69-78
//        (`computeSelectedLayoutSegment` returns null when no descendant
//        is active; otherwise returns the segment string.)
export function selectedChildSegment(
  match: Match | null,
  urlDepth: number,
): string | null {
  if (!match) return null;
  const seg = match.route.segments[urlDepth];
  if (!seg) return null;
  return segmentValue(seg, match.params);
}

// `useSelectedLayoutSegment(slot)` semantics: returns the slot's deepest
// segment value, or `null` when the slot has no active page. Mirrors
// Next.js's `computeSelectedLayoutSegment(segments, slot)` which returns
// `segments[segments.length - 1]` for non-`children` slots
// (segment.js:74).
//
// In Crucible, slot routes start their segments at the URL root (e.g.
// `(.)orders/new` under `@dialog/` has segments `[orders, new]`), so
// "deepest" means the last segment of the slot's match.
export function selectedSlotSegment(match: Match | null): string | null {
  if (!match) return null;
  const segments = match.route.segments;
  if (segments.length === 0) return null;
  const seg = segments[segments.length - 1]!;
  return segmentValue(seg, match.params);
}
