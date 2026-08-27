import { test, expect, describe, mock, beforeEach } from "bun:test";
import { resolveAndLoad, EMPTY_RESOLUTION, disposeResolution } from "./resolve.ts";
import { bucketRoutes } from "./buckets.ts";
import { fakeEntrypoint, makeRoute } from "./test-fixtures.ts";
import type { Match } from "./types.ts";
import type { Environment } from "../environment.ts";

// `loadQuery` mock — every call returns a fresh sentinel with a dispose
// counter. Tests that need to assert disposal correctness use the
// shared `activeRefs` array. Tests that don't care simply ignore it.
let activeRefs: Array<{ disposed: boolean }> = [];
mock.module("react-relay", () => ({
  loadQuery: () => {
    const ref = { disposed: false };
    activeRefs.push(ref);
    return {
      dispose: () => {
        ref.disposed = true;
      },
    };
  },
}));
beforeEach(() => {
  activeRefs = [];
});

// Minimum fake Relay environment for `loadEntrypoint` — `loadQuery` is the
// only public surface it touches. Empty object is enough; the loaders
// pass it through to relay-runtime which we don't exercise here.
const fakeEnv = {} as Environment["relay"];

function loc(pathname: string) {
  return {
    pathname,
    search: new URLSearchParams(),
    hash: "",
  };
}

const NO_PREV = { lastMain: null, lastSlots: new Map<string, Match>() };

describe("resolveAndLoad — main route resolution", () => {
  test("matches a regular main route on hard nav", () => {
    const orders = makeRoute([{ kind: "literal", value: "orders" }]);
    const buckets = bucketRoutes([orders]);

    const r = resolveAndLoad(buckets, loc("/orders"), "init", fakeEnv, NO_PREV);

    expect(r.main?.route).toBe(orders);
    expect(r.mainCommit).toBe(r.main!);
    expect(r.mainLoaded?.route).toBe(orders);
  });

  test("falls back to default on unmatched URL with default present", () => {
    const dashboardDefault = makeRoute([], { kind: "default" });
    const buckets = bucketRoutes([dashboardDefault]);

    const r = resolveAndLoad(
      buckets,
      loc("/unknown"),
      "init",
      fakeEnv,
      NO_PREV,
    );

    expect(r.main?.route).toBe(dashboardDefault);
    // Defaults don't commit (not exact-match pages).
    expect(r.mainCommit).toBeUndefined();
    expect(r.mainLoaded?.route).toBe(dashboardDefault);
  });

  test("returns null main when no route matches and no default exists", () => {
    const orders = makeRoute([{ kind: "literal", value: "orders" }]);
    const buckets = bucketRoutes([orders]);

    const r = resolveAndLoad(
      buckets,
      loc("/missing"),
      "init",
      fakeEnv,
      NO_PREV,
    );

    expect(r.main).toBeNull();
    expect(r.mainLoaded).toBeNull();
  });

  test("preserves lastMain on soft nav when URL has no match (no flash)", () => {
    const orders = makeRoute([{ kind: "literal", value: "orders" }]);
    const buckets = bucketRoutes([orders]);
    const lastMain: Match = { route: orders, params: {} };

    // `/missing` has no route but soft nav holds previous main visible.
    const r = resolveAndLoad(buckets, loc("/missing"), "soft", fakeEnv, {
      lastMain,
      lastSlots: new Map(),
    });

    expect(r.main).toBe(lastMain);
    // mainCommit must be undefined — we're showing stale, not committing.
    expect(r.mainCommit).toBeUndefined();
  });

  test("hard nav (init/pop) does NOT preserve lastMain on miss — falls through to default/null", () => {
    const orders = makeRoute([{ kind: "literal", value: "orders" }]);
    const buckets = bucketRoutes([orders]);
    const lastMain: Match = { route: orders, params: {} };

    const rInit = resolveAndLoad(buckets, loc("/missing"), "init", fakeEnv, {
      lastMain,
      lastSlots: new Map(),
    });
    expect(rInit.main).toBeNull();

    const rPop = resolveAndLoad(buckets, loc("/missing"), "pop", fakeEnv, {
      lastMain,
      lastSlots: new Map(),
    });
    expect(rPop.main).toBeNull();
  });

  test("uses the supplied matcher for actual resolution", () => {
    const orders = makeRoute([{ kind: "literal", value: "orders" }]);
    const buckets = bucketRoutes([orders]);
    const customMatcher = (routes: typeof buckets.mainRoutes, pathname: string) =>
      pathname === "/ORDERS" ? { route: routes[0]!, params: {} } : null;

    const r = resolveAndLoad(
      buckets,
      loc("/ORDERS"),
      "init",
      fakeEnv,
      NO_PREV,
      customMatcher,
    );

    expect(r.main?.route).toBe(orders);
  });
});

describe("resolveAndLoad — slot resolution", () => {
  test("matches a regular slot route", () => {
    const main = makeRoute([]);
    const dialog = makeRoute(
      [
        { kind: "literal", value: "orders" },
        { kind: "literal", value: "new" },
      ],
      { slot: "dialog" },
    );
    const buckets = bucketRoutes([main, dialog]);

    const r = resolveAndLoad(
      buckets,
      loc("/orders/new"),
      "init",
      fakeEnv,
      NO_PREV,
    );

    expect(r.slotMatches.get("dialog")?.route).toBe(dialog);
    expect(r.slotPageCommits.get("dialog")?.route).toBe(dialog);
    expect(r.slotLoaded.get("dialog")?.route).toBe(dialog);
  });

  test("slot returns null for declared slot that has no match", () => {
    const main = makeRoute([]);
    const dialog = makeRoute(
      [
        { kind: "literal", value: "orders" },
        { kind: "literal", value: "new" },
      ],
      { slot: "dialog" },
    );
    const buckets = bucketRoutes([main, dialog]);

    const r = resolveAndLoad(buckets, loc("/"), "init", fakeEnv, NO_PREV);

    // dialog is declared (allSlots) but has no route for `/`.
    expect(r.slotMatches.has("dialog")).toBe(true);
    expect(r.slotMatches.get("dialog")).toBeNull();
  });

  test("slot default fills in when no page route matches", () => {
    const main = makeRoute([]);
    const slotPage = makeRoute(
      [
        { kind: "literal", value: "orders" },
        { kind: "literal", value: "new" },
      ],
      { slot: "dialog" },
    );
    const slotDefault = makeRoute([], {
      slot: "dialog",
      kind: "default",
    });
    const buckets = bucketRoutes([main, slotPage, slotDefault]);

    const r = resolveAndLoad(buckets, loc("/"), "init", fakeEnv, NO_PREV);

    // Dialog slot has no page match for `/`, default kicks in.
    expect(r.slotMatches.get("dialog")?.route).toBe(slotDefault);
  });

  test("soft nav preserves slot's last-rendered page when no current page match", () => {
    const main = makeRoute([]);
    const slotPage = makeRoute(
      [
        { kind: "literal", value: "orders" },
        { kind: "literal", value: "new" },
      ],
      { slot: "dialog" },
    );
    const buckets = bucketRoutes([main, slotPage]);
    const lastSlot: Match = { route: slotPage, params: {} };

    const r = resolveAndLoad(buckets, loc("/"), "soft", fakeEnv, {
      lastMain: null,
      lastSlots: new Map([["dialog", lastSlot]]),
    });

    expect(r.slotMatches.get("dialog")).toBe(lastSlot);
  });
});

describe("resolveAndLoad — intercept routes", () => {
  test("soft nav fires intercept and freezes main beneath it", () => {
    const orders = makeRoute([{ kind: "literal", value: "orders" }]);
    const ordersNew = makeRoute([
      { kind: "literal", value: "orders" },
      { kind: "literal", value: "new" },
    ]);
    const dialogIntercept = makeRoute(
      [
        { kind: "literal", value: "orders" },
        { kind: "literal", value: "new" },
      ],
      { slot: "dialog", intercept: true },
    );
    const buckets = bucketRoutes([orders, ordersNew, dialogIntercept]);
    const lastMain: Match = { route: orders, params: {} };

    const r = resolveAndLoad(buckets, loc("/orders/new"), "soft", fakeEnv, {
      lastMain,
      lastSlots: new Map(),
    });

    // Dialog slot picked up the intercept.
    expect(r.slotMatches.get("dialog")?.route).toBe(dialogIntercept);
    // Main is FROZEN at the previous match (orders), NOT the matching
    // ordersNew route — that's the whole point of intercepts.
    expect(r.main).toBe(lastMain);
    // mainCommit is undefined — we're not committing the frozen state.
    expect(r.mainCommit).toBeUndefined();
  });

  test("hard nav does NOT fire intercepts (skips the dialog overlay)", () => {
    const orders = makeRoute([{ kind: "literal", value: "orders" }]);
    const ordersNew = makeRoute([
      { kind: "literal", value: "orders" },
      { kind: "literal", value: "new" },
    ]);
    const dialogIntercept = makeRoute(
      [
        { kind: "literal", value: "orders" },
        { kind: "literal", value: "new" },
      ],
      { slot: "dialog", intercept: true },
    );
    const buckets = bucketRoutes([orders, ordersNew, dialogIntercept]);

    const rInit = resolveAndLoad(
      buckets,
      loc("/orders/new"),
      "init",
      fakeEnv,
      NO_PREV,
    );
    expect(rInit.slotMatches.get("dialog")).toBeNull();
    // Main resolves normally on hard nav, no freeze.
    expect(rInit.main?.route).toBe(ordersNew);

    const rPop = resolveAndLoad(
      buckets,
      loc("/orders/new"),
      "pop",
      fakeEnv,
      NO_PREV,
    );
    expect(rPop.slotMatches.get("dialog")).toBeNull();
    expect(rPop.main?.route).toBe(ordersNew);
  });

  test("same-page nav (search-param-only) suppresses intercept", () => {
    const orders = makeRoute([{ kind: "literal", value: "orders" }]);
    const dialogIntercept = makeRoute(
      [{ kind: "literal", value: "orders" }],
      { slot: "dialog", intercept: true },
    );
    const buckets = bucketRoutes([orders, dialogIntercept]);
    const lastMain: Match = { route: orders, params: {} };

    // User is on `/orders`; soft nav to `/orders?filter=archived` would
    // still match the intercept by URL — but the destination's underlying
    // page route equals lastMain.route, so the intercept must NOT fire.
    const r = resolveAndLoad(buckets, loc("/orders"), "soft", fakeEnv, {
      lastMain,
      lastSlots: new Map(),
    });

    // Intercept suppressed — slotMatches has no entry for dialog (the loop
    // never ran for it because samePageNav cleared the soft-nav branch).
    expect(r.slotMatches.get("dialog") ?? null).toBeNull();
    // Main re-resolves to the same underlying route record.
    expect(r.main?.route).toBe(orders);
  });
});

describe("resolveAndLoad — params", () => {
  test("dynamic param binds correctly through resolve → load", () => {
    const order = makeRoute([
      { kind: "literal", value: "orders" },
      { kind: "param", name: "id" },
    ]);
    const buckets = bucketRoutes([order]);

    const r = resolveAndLoad(
      buckets,
      loc("/orders/abc-123"),
      "init",
      fakeEnv,
      NO_PREV,
    );

    expect(r.main?.params).toEqual({ id: "abc-123" });
  });

  test("specificity: literal beats param at the same position", () => {
    // Even if the codegen emits in disk order ([id] before new), the
    // bucket sorter promotes /orders/new above /orders/[id] for clean
    // first-match-wins matching.
    const orderById = makeRoute([
      { kind: "literal", value: "orders" },
      { kind: "param", name: "id" },
    ]);
    const orderNew = makeRoute([
      { kind: "literal", value: "orders" },
      { kind: "literal", value: "new" },
    ]);
    const buckets = bucketRoutes([orderById, orderNew]);

    const r = resolveAndLoad(
      buckets,
      loc("/orders/new"),
      "init",
      fakeEnv,
      NO_PREV,
    );

    expect(r.main?.route).toBe(orderNew);
    expect(r.main?.params).toEqual({});
  });
});

describe("EMPTY_RESOLUTION", () => {
  test("is the inert null resolution", () => {
    expect(EMPTY_RESOLUTION.main).toBeNull();
    expect(EMPTY_RESOLUTION.mainLoaded).toBeNull();
    expect(EMPTY_RESOLUTION.slotMatches.size).toBe(0);
    expect(EMPTY_RESOLUTION.slotLoaded.size).toBe(0);
    expect(EMPTY_RESOLUTION.slotPageCommits.size).toBe(0);
  });
});

describe("disposeResolution — concurrent-nav cancellation contract", () => {
  test("releases every queryRef across main + slots", () => {
    const main = makeRoute([{ kind: "literal", value: "x" }], {
      entrypoint: {
        ...fakeEntrypoint("main"),
        getPreloadProps: () => ({
          queries: {
            a: { parameters: {} as never, variables: {} as never },
            b: { parameters: {} as never, variables: {} as never },
          },
        }),
      },
    });
    const slot = makeRoute([{ kind: "literal", value: "x" }], {
      slot: "dialog",
      entrypoint: {
        ...fakeEntrypoint("slot"),
        getPreloadProps: () => ({
          queries: {
            c: { parameters: {} as never, variables: {} as never },
          },
        }),
      },
    });
    const buckets = bucketRoutes([main, slot]);

    const res = resolveAndLoad(
      buckets,
      { pathname: "/x", search: new URLSearchParams(), hash: "" },
      "init",
      fakeEnv,
      { lastMain: null, lastSlots: new Map() },
    );

    // 2 main + 1 slot = 3 queryRefs.
    expect(activeRefs.length).toBe(3);
    expect(activeRefs.every((r) => !r.disposed)).toBe(true);

    disposeResolution(res);
    expect(activeRefs.every((r) => r.disposed)).toBe(true);
  });

  test("100 rapid navs simulation: only the latest resolution holds live refs", () => {
    const route = makeRoute([{ kind: "literal", value: "x" }], {
      entrypoint: {
        ...fakeEntrypoint("p"),
        getPreloadProps: () => ({
          queries: {
            q: { parameters: {} as never, variables: {} as never },
          },
        }),
      },
    });
    const buckets = bucketRoutes([route]);

    // Reproduces what `applyNav` does on every nav: dispose the prior
    // pending resolution before firing a new one. After 100 navs, only
    // the final one should hold undisposed refs.
    let pending: ReturnType<typeof resolveAndLoad> | null = null;
    for (let i = 0; i < 100; i++) {
      if (pending) disposeResolution(pending);
      pending = resolveAndLoad(
        buckets,
        { pathname: "/x", search: new URLSearchParams(), hash: "" },
        "init",
        fakeEnv,
        { lastMain: null, lastSlots: new Map() },
      );
    }

    expect(activeRefs.length).toBe(100);
    const undisposed = activeRefs.filter((r) => !r.disposed);
    expect(undisposed.length).toBe(1);
  });

  test("idempotent: calling disposeResolution twice doesn't crash", () => {
    const route = makeRoute([{ kind: "literal", value: "x" }], {
      entrypoint: {
        ...fakeEntrypoint("p"),
        getPreloadProps: () => ({
          queries: {
            q: { parameters: {} as never, variables: {} as never },
          },
        }),
      },
    });
    const buckets = bucketRoutes([route]);
    const res = resolveAndLoad(
      buckets,
      { pathname: "/x", search: new URLSearchParams(), hash: "" },
      "init",
      fakeEnv,
      { lastMain: null, lastSlots: new Map() },
    );

    expect(() => {
      disposeResolution(res);
      disposeResolution(res);
    }).not.toThrow();
  });

  test("safe on a no-match resolution (main: null, no slots)", () => {
    const buckets = bucketRoutes([]);
    const res = resolveAndLoad(
      buckets,
      { pathname: "/missing", search: new URLSearchParams(), hash: "" },
      "init",
      fakeEnv,
      { lastMain: null, lastSlots: new Map() },
    );
    expect(res.main).toBeNull();
    expect(() => disposeResolution(res)).not.toThrow();
  });
});

describe("resolveAndLoad — adversarial inputs", () => {
  test("route with no queries has a clean resolution shape", () => {
    const route = makeRoute([{ kind: "literal", value: "static" }]);
    const buckets = bucketRoutes([route]);
    const res = resolveAndLoad(
      buckets,
      { pathname: "/static", search: new URLSearchParams(), hash: "" },
      "init",
      fakeEnv,
      { lastMain: null, lastSlots: new Map() },
    );
    expect(res.main?.route).toBe(route);
    expect(res.mainLoaded?.preloaded).toEqual({});
    expect(activeRefs.length).toBe(0);
  });

  test("getPreloadProps returning null queries throws — codegen contract pin", () => {
    // The router doesn't defend against null/undefined values in the
    // queries map because codegen never produces them — a violation
    // surfaces as a TypeError at resolve time, which is the expected
    // (loud) failure mode for a contract bug. This test pins the
    // contract: if codegen ever emits null, the failure has a clear
    // stack pointing at load.ts.
    const route = makeRoute([{ kind: "literal", value: "x" }], {
      entrypoint: {
        ...fakeEntrypoint("p"),
        getPreloadProps: () => ({
          queries: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            bad: null as any,
          },
        }),
      },
    });
    const buckets = bucketRoutes([route]);
    expect(() =>
      resolveAndLoad(
        buckets,
        { pathname: "/x", search: new URLSearchParams(), hash: "" },
        "init",
        fakeEnv,
        { lastMain: null, lastSlots: new Map() },
      ),
    ).toThrow(/parameters/);
  });
});
