import { test, expect, describe, mock, beforeEach } from "bun:test";
import {
  disposeLoadedEntrypoint,
  disposeLoadedSub,
  loadEntrypoint,
  loadSub,
  readResource,
} from "./load.ts";
import { JSResource, type PreloadParams } from "../entrypoint.ts";
import {
  fakeEntrypoint,
  fakeLayoutResource,
  fakePageResource,
  fakeSubEntrypoint,
  fakeSubResource,
  makeRoute,
} from "./test-fixtures.ts";
import type { Frame, Match } from "./types.ts";
import type { Environment } from "../environment.ts";

// `loadQuery` is what the loaders call into. We mock it to record args
// without actually exercising the Relay store. The handle returned is a
// sentinel — callers store it in a record but never inspect its shape.
const loadQuerySpy = mock(
  (_env: never, _parameters: never, _variables: never, _options: never) => ({
    __sentinel: true,
  }),
);

mock.module("react-relay", () => ({
  loadQuery: (
    env: unknown,
    parameters: unknown,
    variables: unknown,
    options: unknown,
  ) =>
    loadQuerySpy(
      env as never,
      parameters as never,
      variables as never,
      options as never,
    ),
}));

beforeEach(() => {
  loadQuerySpy.mockClear();
});

const fakeEnv = {} as Environment["relay"];

function fakeQuery(name: string) {
  return {
    parameters: { id: name } as never,
    variables: { x: name } as never,
  };
}

describe("loadSub", () => {
  test("fires loadQuery for each declared query and starts the chunk load", () => {
    const sub = fakeSubEntrypoint(
      { a: fakeQuery("a"), b: fakeQuery("b") },
      "sub-root",
    );

    const result = loadSub(fakeEnv, sub, {
      params: {},
      search: new URLSearchParams(),
    } satisfies PreloadParams);

    expect(loadQuerySpy).toHaveBeenCalledTimes(2);
    expect(result.preloaded).toHaveProperty("a");
    expect(result.preloaded).toHaveProperty("b");
    // The fixture exposes its load counter via `_loadCount` on the root.
    const root = sub.root as ReturnType<typeof fakeSubResource>;
    expect(root._loadCount.value).toBe(1);
  });

  test("recurses into nested sub-entrypoints", () => {
    const inner = fakeSubEntrypoint({ z: fakeQuery("z") }, "inner");
    const outer = fakeSubEntrypoint({ y: fakeQuery("y") }, "outer");
    outer.entryPoints = { inner };

    const result = loadSub(fakeEnv, outer, {
      params: {},
      search: new URLSearchParams(),
    });

    // 1 query at outer + 1 at inner = 2 loadQuery calls.
    expect(loadQuerySpy).toHaveBeenCalledTimes(2);
    const outerRoot = outer.root as ReturnType<typeof fakeSubResource>;
    const innerRoot = inner.root as ReturnType<typeof fakeSubResource>;
    expect(outerRoot._loadCount.value).toBe(1);
    expect(innerRoot._loadCount.value).toBe(1);
    expect(result.entryPoints.inner).toBeDefined();
  });

  test("uses store-and-network fetchPolicy", () => {
    const sub = fakeSubEntrypoint({ q: fakeQuery("q") });

    loadSub(fakeEnv, sub, {
      params: {},
      search: new URLSearchParams(),
    });

    expect(loadQuerySpy).toHaveBeenCalledWith(
      fakeEnv,
      expect.anything(),
      expect.anything(),
      { fetchPolicy: "store-and-network" },
    );
  });

  test("passes preload params through to getPreloadProps", () => {
    let captured: PreloadParams | null = null;
    const sub = fakeSubEntrypoint({});
    sub.getPreloadProps = (preload) => {
      captured = preload;
      return { queries: {} };
    };

    const search = new URLSearchParams("foo=1");
    loadSub(fakeEnv, sub, { params: { id: "x" }, search });

    expect(captured).not.toBeNull();
    expect(captured!.params).toEqual({ id: "x" });
    expect(captured!.search).toBe(search);
  });
});

describe("loadEntrypoint", () => {
  test("fires page queries and starts the page chunk", () => {
    const root = fakePageResource("page-root");
    const entrypoint = {
      root,
      getPreloadProps: () => ({ queries: { main: fakeQuery("main") } }),
    };
    const route = makeRoute([], { entrypoint });
    const match: Match = { route, params: {} };

    const result = loadEntrypoint(fakeEnv, match, {
      pathname: "/",
      search: new URLSearchParams(),
      hash: "",
    });

    expect(loadQuerySpy).toHaveBeenCalledTimes(1);
    expect(result.preloaded).toHaveProperty("main");
    expect(root._loadCount.value).toBe(1);
  });

  test("starts every frame's layout chunk in parallel with the page", () => {
    const layout1 = fakeLayoutResource("layout1");
    const layout2 = fakeLayoutResource("layout2");
    const root = fakePageResource("page-root");

    const frames: Frame[] = [{ layout: layout1 }, { layout: layout2 }];
    const route = makeRoute([], {
      frames,
      entrypoint: { root, getPreloadProps: () => ({ queries: {} }) },
    });
    const match: Match = { route, params: {} };

    loadEntrypoint(fakeEnv, match, {
      pathname: "/",
      search: new URLSearchParams(),
      hash: "",
    });

    expect(layout1._loadCount.value).toBe(1);
    expect(layout2._loadCount.value).toBe(1);
    expect(root._loadCount.value).toBe(1);
  });

  test("frames without a layout are skipped (no crash)", () => {
    const route = makeRoute([], { frames: [{}, {}] });
    const match: Match = { route, params: {} };

    expect(() =>
      loadEntrypoint(fakeEnv, match, {
        pathname: "/",
        search: new URLSearchParams(),
        hash: "",
      }),
    ).not.toThrow();
  });

  test("recurses through page's sub-entrypoints", () => {
    const root = fakePageResource("page-root");
    const sidebar = fakeSubEntrypoint(
      { side: fakeQuery("side") },
      "sub-root",
    );
    const route = makeRoute([], {
      entrypoint: {
        root,
        getPreloadProps: () => ({ queries: {} }),
        entryPoints: { sidebar },
      },
    });
    const match: Match = { route, params: {} };

    const result = loadEntrypoint(fakeEnv, match, {
      pathname: "/",
      search: new URLSearchParams(),
      hash: "",
    });

    expect(result.entryPoints.sidebar).toBeDefined();
    expect(result.entryPoints.sidebar?.preloaded).toHaveProperty("side");
    const subRoot = sidebar.root as ReturnType<typeof fakeSubResource>;
    expect(subRoot._loadCount.value).toBe(1);
  });

  test("preload includes match params and search", () => {
    let captured: PreloadParams | null = null;
    const ep = fakeEntrypoint();
    ep.getPreloadProps = (preload) => {
      captured = preload;
      return { queries: {} };
    };
    const route = makeRoute([], { entrypoint: ep });
    const match: Match = { route, params: { id: "abc" } };
    const search = new URLSearchParams("tab=archived");

    loadEntrypoint(fakeEnv, match, {
      pathname: "/orders/abc",
      search,
      hash: "",
    });

    expect(captured).not.toBeNull();
    expect(captured!.params).toEqual({ id: "abc" });
    expect(captured!.search).toBe(search);
  });
});

describe("readResource — Suspense protocol", () => {
  test("returns the cached module synchronously when loaded", async () => {
    const r = fakePageResource("mod");
    await r.load();
    const mod = readResource(r);
    expect(mod).toBeDefined();
    expect("default" in mod).toBe(true);
  });

  test("throws the load promise when not yet loaded (Suspense convention)", () => {
    const r = JSResource("mod-2", () =>
      Promise.resolve({ default: () => null }),
    );

    let thrown: unknown;
    try {
      readResource(r);
    } catch (e) {
      thrown = e;
    }
    // Suspense expects a thenable to be thrown.
    expect(thrown).toBeDefined();
    expect(typeof (thrown as { then?: unknown })?.then).toBe("function");
  });
});

describe("disposeLoadedSub / disposeLoadedEntrypoint", () => {
  test("disposeLoadedSub releases every queryRef + recurses into nested subs", () => {
    const inner = fakeSubEntrypoint({ z: fakeQuery("z") }, "inner");
    const outer = fakeSubEntrypoint({ y: fakeQuery("y") }, "outer");
    outer.entryPoints = { inner };
    const loaded = loadSub(fakeEnv, outer, {
      params: {},
      search: new URLSearchParams(),
    });

    // Wire dispose tracking via a fresh loadQuery mock for this scope.
    const disposed: Array<{ value: number }> = [];
    for (const ref of Object.values(loaded.preloaded)) {
      const counter = { value: 0 };
      disposed.push(counter);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ref as any).dispose = () => {
        counter.value++;
      };
    }
    for (const child of Object.values(loaded.entryPoints)) {
      for (const ref of Object.values(child.preloaded)) {
        const counter = { value: 0 };
        disposed.push(counter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (ref as any).dispose = () => {
          counter.value++;
        };
      }
    }

    disposeLoadedSub(loaded);
    expect(disposed.every((c) => c.value === 1)).toBe(true);
  });

  test("disposeLoadedEntrypoint covers page queries + sub-entrypoints", () => {
    const root = fakePageResource("page");
    const sub = fakeSubEntrypoint({ s: fakeQuery("s") }, "sub");
    const route = makeRoute([], {
      entrypoint: {
        root,
        getPreloadProps: () => ({ queries: { p: fakeQuery("p") } }),
        entryPoints: { sub },
      },
    });
    const match: Match = { route, params: {} };
    const loaded = loadEntrypoint(fakeEnv, match, {
      pathname: "/",
      search: new URLSearchParams(),
      hash: "",
    });

    let disposeCount = 0;
    for (const ref of Object.values(loaded.preloaded)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ref as any).dispose = () => disposeCount++;
    }
    for (const child of Object.values(loaded.entryPoints)) {
      for (const ref of Object.values(child.preloaded)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (ref as any).dispose = () => disposeCount++;
      }
    }

    disposeLoadedEntrypoint(loaded);
    // 1 page query + 1 sub query
    expect(disposeCount).toBe(2);
  });

  test("disposeLoadedEntrypoint on entry with no queries doesn't crash", () => {
    const route = makeRoute([]);
    const match: Match = { route, params: {} };
    const loaded = loadEntrypoint(fakeEnv, match, {
      pathname: "/",
      search: new URLSearchParams(),
      hash: "",
    });
    expect(() => disposeLoadedEntrypoint(loaded)).not.toThrow();
  });
});

describe("JSResource — error recovery", () => {
  test("clears pending on rejection so retry actually retries", async () => {
    let attempt = 0;
    const r = JSResource("flaky", () => {
      attempt++;
      if (attempt === 1) return Promise.reject(new Error("first try"));
      return Promise.resolve({ default: () => null });
    });

    let firstError: unknown;
    try {
      await r.load();
    } catch (e) {
      firstError = e;
    }
    expect(firstError).toBeInstanceOf(Error);

    // Second call must actually retry (not return the rejection).
    const mod = await r.load();
    expect(mod).toBeDefined();
    expect(attempt).toBe(2);
  });

  test("dedupes concurrent loads to the same in-flight promise", async () => {
    let attempt = 0;
    const r = JSResource("dedup", () => {
      attempt++;
      return Promise.resolve({ default: () => null });
    });

    const p1 = r.load();
    const p2 = r.load();
    await Promise.all([p1, p2]);
    expect(attempt).toBe(1);
  });

  test("subsequent loads after success return cached module without re-fetching", async () => {
    let attempt = 0;
    const r = JSResource("cached", () => {
      attempt++;
      return Promise.resolve({ default: () => null });
    });

    await r.load();
    await r.load();
    await r.load();
    expect(attempt).toBe(1);
  });

  // ── Adversarial scenarios ─────────────────────────────────────────────
  // The framework's contract under repeated failure / high concurrency.
  // A regression in any of these breaks Suspense + error boundaries,
  // which would degrade real users on flaky networks.

  test("readResource throws a thenable (Suspense protocol) when uncached", () => {
    // Use a never-resolving loader so the rejection doesn't surface as
    // an unhandled-rejection in the test runner — we only need to
    // observe what readResource throws synchronously.
    const r = JSResource("never", () => new Promise<object>(() => {}));
    let thrown: unknown;
    try {
      readResource(r);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    // Suspense convention: a not-yet-loaded resource throws a thenable
    // that React waits on.
    expect(typeof (thrown as { then?: unknown })?.then).toBe("function");
  });

  test("repeated rejection: each attempt actually re-runs the loader", async () => {
    let attempts = 0;
    const r = JSResource("flaky-forever", () => {
      attempts++;
      return Promise.reject(new Error(`attempt ${attempts}`));
    });

    // Three back-to-back attempts, all failing. Each MUST genuinely
    // re-invoke the loader — otherwise the error boundary's
    // "Try again" button is broken (it'd return the same cached
    // rejection forever).
    for (let i = 1; i <= 3; i++) {
      try {
        await r.load();
        throw new Error("expected rejection");
      } catch (e) {
        expect((e as Error).message).toContain(`attempt ${i}`);
      }
    }
    expect(attempts).toBe(3);
  });

  test("50 concurrent loads share one in-flight promise (no duplicate fetches)", async () => {
    let attempts = 0;
    const r = JSResource("shared", () => {
      attempts++;
      return new Promise<{ default: () => null }>((resolve) => {
        setTimeout(() => resolve({ default: () => null }), 10);
      });
    });

    const promises = Array.from({ length: 50 }, () => r.load());
    await Promise.all(promises);
    expect(attempts).toBe(1);
  });

  test("rejection-then-success: error path doesn't poison cache", async () => {
    let attempts = 0;
    const r = JSResource("recover", () => {
      attempts++;
      if (attempts < 3) return Promise.reject(new Error("net"));
      return Promise.resolve({ default: () => null });
    });

    for (let i = 0; i < 2; i++) {
      try {
        await r.load();
      } catch {
        /* expected */
      }
    }
    const mod = await r.load();
    expect(mod).toBeDefined();
    expect(attempts).toBe(3);

    // After success, further loads return cached without re-running.
    await r.load();
    await r.load();
    expect(attempts).toBe(3);
  });
});
