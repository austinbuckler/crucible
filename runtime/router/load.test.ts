import { test, expect, describe, mock, beforeEach } from "bun:test";
import {
  disposeLoadedEntrypoint,
  loadEntrypoint,
  readResource,
} from "./load.ts";
import { JSResource, type PreloadParams } from "../entrypoint.ts";
import {
  fakeEntrypoint,
  fakeLayoutResource,
  fakePageResource,
  makeRoute,
} from "./test-fixtures.ts";
import type { Frame, Match } from "./types.ts";
import type { Environment } from "../environment.ts";

const loadQuerySpy = mock(
  (_env: never, _parameters: never, _variables: never, _options: never) => ({
    __sentinel: true,
    dispose: () => {},
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

  test("uses store-and-network fetchPolicy", () => {
    const route = makeRoute([], {
      entrypoint: {
        root: fakePageResource("page-root"),
        getPreloadProps: () => ({ queries: { q: fakeQuery("q") } }),
      },
    });
    const match: Match = { route, params: {} };

    loadEntrypoint(fakeEnv, match, {
      pathname: "/",
      search: new URLSearchParams(),
      hash: "",
    });

    expect(loadQuerySpy).toHaveBeenCalledWith(
      fakeEnv,
      expect.anything(),
      expect.anything(),
      { fetchPolicy: "store-and-network" },
    );
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

  test("frames without a layout are skipped", () => {
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

  test("throws the load promise when not yet loaded", () => {
    const r = JSResource("mod-2", () =>
      Promise.resolve({ default: () => null }),
    );

    let thrown: unknown;
    try {
      readResource(r);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(typeof (thrown as { then?: unknown })?.then).toBe("function");
  });
});

describe("disposeLoadedEntrypoint", () => {
  test("releases every page queryRef", () => {
    const route = makeRoute([], {
      entrypoint: {
        root: fakePageResource("page"),
        getPreloadProps: () => ({
          queries: { a: fakeQuery("a"), b: fakeQuery("b") },
        }),
      },
    });
    const loaded = loadEntrypoint(fakeEnv, { route, params: {} }, {
      pathname: "/",
      search: new URLSearchParams(),
      hash: "",
    });

    let disposeCount = 0;
    for (const ref of Object.values(loaded.preloaded)) {
      (ref as { dispose: () => void }).dispose = () => disposeCount++;
    }

    disposeLoadedEntrypoint(loaded);
    expect(disposeCount).toBe(2);
  });

  test("entry with no queries doesn't crash", () => {
    const route = makeRoute([]);
    const loaded = loadEntrypoint(fakeEnv, { route, params: {} }, {
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
    expect(attempt).toBe(1);
  });
});
