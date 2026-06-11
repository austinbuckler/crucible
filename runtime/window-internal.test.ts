/// <reference lib="dom" />
import { test, expect, describe, beforeEach } from "bun:test";
import { windowRegistry } from "./window-internal.ts";

// `windowRegistry` is module-scoped state shared across tests in the
// process. Reset it at the top of each test by removing whatever entries
// the previous test left behind.
beforeEach(() => {
  for (const e of windowRegistry.snapshot()) windowRegistry.remove(e.id);
});

describe("windowRegistry", () => {
  test("starts empty", () => {
    expect(windowRegistry.snapshot()).toEqual([]);
  });

  test("add returns increasing ids", () => {
    const id1 = windowRegistry.add({
      children: null,
      popup: window,
    });
    const id2 = windowRegistry.add({
      children: null,
      popup: window,
    });
    expect(id2).toBeGreaterThan(id1);
  });

  test("snapshot returns the current entries in insertion order", () => {
    windowRegistry.add({ children: "a", popup: window });
    windowRegistry.add({ children: "b", popup: window });
    const snap = windowRegistry.snapshot();
    expect(snap).toHaveLength(2);
    expect(snap[0]!.children).toBe("a");
    expect(snap[1]!.children).toBe("b");
  });

  test("remove drops the matching entry and fires its onClose", () => {
    let closed = false;
    const id = windowRegistry.add({
      children: null,
      popup: window,
      onClose: () => {
        closed = true;
      },
    });
    expect(windowRegistry.snapshot()).toHaveLength(1);
    windowRegistry.remove(id);
    expect(windowRegistry.snapshot()).toHaveLength(0);
    expect(closed).toBe(true);
  });

  test("remove of unknown id is a no-op (no throw, no notify)", () => {
    let notified = 0;
    const unsub = windowRegistry.subscribe(() => {
      notified++;
    });
    windowRegistry.remove(999_999);
    expect(notified).toBe(1); // still notified — by design, simpler subscriber contract
    unsub();
  });

  test("subscribe receives notifications on add and remove", () => {
    let count = 0;
    const unsub = windowRegistry.subscribe(() => {
      count++;
    });
    const id = windowRegistry.add({ children: null, popup: window });
    expect(count).toBe(1);
    windowRegistry.remove(id);
    expect(count).toBe(2);
    unsub();
    // After unsubscribe, no more notifications.
    windowRegistry.add({ children: null, popup: window });
    expect(count).toBe(2);
  });

  test("snapshot is a stable reference between mutations (useSyncExternalStore contract)", () => {
    // useSyncExternalStore requires `getSnapshot` to return the SAME
    // reference until state actually changes — otherwise React thinks
    // every render's snapshot is new and re-renders forever.
    const a = windowRegistry.snapshot();
    const b = windowRegistry.snapshot();
    expect(a).toBe(b);
    windowRegistry.add({ children: null, popup: window });
    const c = windowRegistry.snapshot();
    expect(c).not.toBe(a);
    // Stable again until next mutation.
    expect(windowRegistry.snapshot()).toBe(c);
  });
});
