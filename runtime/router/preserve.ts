import type { Resolution } from "./resolve.ts";
import type { Match } from "./types.ts";

// Mutates `lastSlots` to reflect the latest resolution's slot state.
//
// - For each slot the resolution committed a page on, write the new match.
// - For each slot in `allSlots` whose resolution had NO page commit AND
//   whose `slotMatches` value is null (no intercept, no preserved-last,
//   no default), delete the lastSlots entry. Without this, a stale match
//   accumulates indefinitely and resurfaces as a "ghost" later — e.g. a
//   dialog slot on a URL that no longer matches anything still renders the
//   prior session's dialog because lastSlots[slot] is stuck.
//
// Slots whose resolution shows an intercept, preserved-last, or default
// (i.e. `slotMatches.get(slot)` is non-null but `slotPageCommits` has no
// entry) are intentionally NOT pruned — those entries are load-bearing
// for the current render and the next soft nav.
export function applySlotCommits(
  lastSlots: Map<string, Match>,
  allSlots: ReadonlyArray<string>,
  resolution: Pick<Resolution, "slotPageCommits" | "slotMatches">,
): void {
  for (const [slot, m] of resolution.slotPageCommits) {
    lastSlots.set(slot, m);
  }
  for (const slot of allSlots) {
    if (resolution.slotPageCommits.has(slot)) continue;
    if (resolution.slotMatches.get(slot) != null) continue;
    lastSlots.delete(slot);
  }
}
