import type { RouteRecord } from "./types.ts";

// Pre-computed partitioning of the routes array. Built once when `<App>`
// receives a routes prop, then reused for every navigation. Keeping the
// buckets stable makes match work O(routes) per nav rather than
// re-filtering the whole list each time.
export type Buckets = {
  mainRoutes: ReadonlyArray<RouteRecord>;
  mainDefaults: ReadonlyArray<RouteRecord>;
  slotRegulars: ReadonlyMap<string, ReadonlyArray<RouteRecord>>;
  slotIntercepts: ReadonlyMap<string, ReadonlyArray<RouteRecord>>;
  slotDefaults: ReadonlyMap<string, ReadonlyArray<RouteRecord>>;
  // Union of every slot name that has any route — needed so the matcher
  // resolves a value (page, last, default, or null) for every declared
  // slot even when only a default exists for it.
  allSlots: ReadonlyArray<string>;
};

export function bucketRoutes(routes: ReadonlyArray<RouteRecord>): Buckets {
  const mainRoutes: RouteRecord[] = [];
  const mainDefaults: RouteRecord[] = [];
  const slotRegulars = new Map<string, RouteRecord[]>();
  const slotIntercepts = new Map<string, RouteRecord[]>();
  const slotDefaults = new Map<string, RouteRecord[]>();
  const slotSet = new Set<string>();

  for (const r of routes) {
    if (!r.slot) {
      if (r.kind === "default") mainDefaults.push(r);
      else mainRoutes.push(r);
      continue;
    }
    slotSet.add(r.slot);
    if (r.kind === "default") {
      pushTo(slotDefaults, r.slot, r);
    } else if (r.intercept) {
      pushTo(slotIntercepts, r.slot, r);
    } else {
      pushTo(slotRegulars, r.slot, r);
    }
  }

  // Page routes match by exact-URL. Codegen emits them in `readdirSync`
  // order which puts `[id]` before `new` (lexicographic on the directory
  // name, where `[` < `n`). With first-match-wins, `/clients/new` would
  // bind to `/clients/[id]` with `id="new"`. Sort by per-segment
  // specificity so a literal beats a param at the same position.
  mainRoutes.sort(bySpecificityDesc);
  for (const list of slotRegulars.values()) list.sort(bySpecificityDesc);
  for (const list of slotIntercepts.values()) list.sort(bySpecificityDesc);

  // Defaults match as prefixes — sort deepest-first so the nearest
  // ancestor wins when multiple defaults cover the URL.
  mainDefaults.sort(byDepthDesc);
  for (const list of slotDefaults.values()) list.sort(byDepthDesc);

  return {
    mainRoutes,
    mainDefaults,
    slotRegulars,
    slotIntercepts,
    slotDefaults,
    allSlots: [...slotSet],
  };
}

function pushTo<K, V>(m: Map<K, V[]>, key: K, value: V): void {
  const list = m.get(key);
  if (list) list.push(value);
  else m.set(key, [value]);
}

export function byDepthDesc(a: RouteRecord, b: RouteRecord): number {
  return b.segments.length - a.segments.length;
}

// Per-segment specificity: literal (2) beats param (1) beats catchall (0).
// Compare positionally. The first position with a non-zero diff decides;
// ties fall through to the next segment. Routes with fewer segments don't
// shadow longer ones — `matchRoute` already requires a full-segment-count
// match — so we don't need to disambiguate by length here.
const SEGMENT_SCORE = { literal: 2, param: 1, catchall: 0 } as const;
export function bySpecificityDesc(a: RouteRecord, b: RouteRecord): number {
  const len = Math.min(a.segments.length, b.segments.length);
  for (let i = 0; i < len; i++) {
    const sa = SEGMENT_SCORE[a.segments[i]!.kind];
    const sb = SEGMENT_SCORE[b.segments[i]!.kind];
    if (sa !== sb) return sb - sa;
  }
  return 0;
}
