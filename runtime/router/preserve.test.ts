import { test, expect, describe } from "bun:test";
import { applySlotCommits } from "./preserve.ts";
import type { Match, RouteRecord } from "./types.ts";

// Minimal RouteRecord stub — applySlotCommits only stores Match objects
// by reference, so the inner shape doesn't matter for this test.
function fakeRoute(path: string): RouteRecord {
  return {
    path,
    segments: [{ kind: "literal", value: path }],
    frames: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entrypoint: {} as any,
  };
}

function fakeMatch(path: string): Match {
  return { route: fakeRoute(path), params: {} };
}

const ALL_SLOTS = ["modal", "drawer"];

describe("applySlotCommits", () => {
  test("writes new page commits into lastSlots", () => {
    const lastSlots = new Map<string, Match>();
    const m = fakeMatch("/orders/1");
    applySlotCommits(lastSlots, ALL_SLOTS, {
      slotPageCommits: new Map([["modal", m]]),
      slotMatches: new Map([
        ["modal", m],
        ["drawer", null],
      ]),
    });
    expect(lastSlots.get("modal")).toBe(m);
  });

  test("removes a slot from lastSlots when the new resolution has no match for it", () => {
    // Seed: a prior session left a stale match in `modal`.
    const stale = fakeMatch("/orders/old");
    const lastSlots = new Map<string, Match>([["modal", stale]]);

    // New navigation: nothing matches `modal` (no intercept, no preserved-
    // last carried in resolution, no default).
    applySlotCommits(lastSlots, ALL_SLOTS, {
      slotPageCommits: new Map(),
      slotMatches: new Map([
        ["modal", null],
        ["drawer", null],
      ]),
    });

    expect(lastSlots.has("modal")).toBe(false);
  });

  test("does NOT prune when the slot resolution is non-null (intercept / preserved-last / default)", () => {
    const preserved = fakeMatch("/orders/1");
    const lastSlots = new Map<string, Match>([["modal", preserved]]);

    // Resolution shows the slot still has SOMETHING (e.g. preserved-last
    // surfaced by resolveAndLoad), but no fresh page committed.
    applySlotCommits(lastSlots, ALL_SLOTS, {
      slotPageCommits: new Map(),
      slotMatches: new Map<string, Match | null>([
        ["modal", preserved],
        ["drawer", null],
      ]),
    });

    expect(lastSlots.get("modal")).toBe(preserved);
  });

  test("does not accumulate stale entries across a sequence of navigations", () => {
    const lastSlots = new Map<string, Match>();

    // Nav 1: enter a modal route → page commits to "modal".
    const modal1 = fakeMatch("/orders/1/edit");
    applySlotCommits(lastSlots, ALL_SLOTS, {
      slotPageCommits: new Map([["modal", modal1]]),
      slotMatches: new Map([
        ["modal", modal1],
        ["drawer", null],
      ]),
    });
    expect(lastSlots.size).toBe(1);

    // Nav 2: navigate elsewhere; nothing matches modal anymore.
    applySlotCommits(lastSlots, ALL_SLOTS, {
      slotPageCommits: new Map(),
      slotMatches: new Map([
        ["modal", null],
        ["drawer", null],
      ]),
    });
    expect(lastSlots.size).toBe(0);

    // Nav 3: enter a different modal route.
    const modal2 = fakeMatch("/orders/2/edit");
    applySlotCommits(lastSlots, ALL_SLOTS, {
      slotPageCommits: new Map([["modal", modal2]]),
      slotMatches: new Map([
        ["modal", modal2],
        ["drawer", null],
      ]),
    });
    expect(lastSlots.size).toBe(1);
    expect(lastSlots.get("modal")).toBe(modal2);
    // Critically: no leak from modal1.
    expect(lastSlots.get("modal")).not.toBe(modal1);
  });

  test("a slot not present in allSlots is left alone (defensive)", () => {
    // If allSlots is somehow narrower than what the resolution carries,
    // we don't accidentally prune slots we don't know about.
    const ghost = fakeMatch("/x");
    const lastSlots = new Map<string, Match>([["unknown", ghost]]);
    applySlotCommits(lastSlots, ALL_SLOTS, {
      slotPageCommits: new Map(),
      slotMatches: new Map([
        ["modal", null],
        ["drawer", null],
      ]),
    });
    expect(lastSlots.get("unknown")).toBe(ghost);
  });
});
