/// <reference lib="dom" />
import { describe, expect, test, mock } from "bun:test";

// Stub loadQuery so warmSubEntrypoint can run without a real Relay env.
let loadQueryCalls: Array<{ parameters: unknown; variables: unknown }> = [];
mock.module("react-relay", () => ({
  loadQuery: (
    _env: unknown,
    parameters: unknown,
    variables: unknown,
  ) => {
    loadQueryCalls.push({ parameters, variables });
    return {
      // Minimal PreloadedQuery shape — only used as opaque ref by the
      // helper. Tests below dispose by counting calls, not by inspecting
      // returned objects.
      dispose: () => {},
    };
  },
}));

const {
  PREFETCH_TTL_MS,
  shouldSkipPrefetch,
  warmSubEntrypoint,
} = await import("./prefetch.ts");
import type {
  PreloadParams,
  QueryParameter,
  SubEntryPoint,
} from "../entrypoint.ts";
import type { PreloadedQuery } from "react-relay";

describe("PREFETCH_TTL_MS", () => {
  test("is sane (≥ 1s, ≤ 5min)", () => {
    expect(PREFETCH_TTL_MS).toBeGreaterThanOrEqual(1000);
    expect(PREFETCH_TTL_MS).toBeLessThanOrEqual(5 * 60 * 1000);
  });
});

describe("shouldSkipPrefetch", () => {
  test("true when navigator.connection.saveData is set", () => {
    const original = (navigator as unknown as { connection?: unknown })
      .connection;
    (navigator as unknown as { connection?: unknown }).connection = {
      saveData: true,
    };
    expect(shouldSkipPrefetch()).toBe(true);
    (navigator as unknown as { connection?: unknown }).connection = original;
  });

  test("true on slow-2g", () => {
    const original = (navigator as unknown as { connection?: unknown })
      .connection;
    (navigator as unknown as { connection?: unknown }).connection = {
      effectiveType: "slow-2g",
    };
    expect(shouldSkipPrefetch()).toBe(true);
    (navigator as unknown as { connection?: unknown }).connection = original;
  });

  test("true on 2g", () => {
    const original = (navigator as unknown as { connection?: unknown })
      .connection;
    (navigator as unknown as { connection?: unknown }).connection = {
      effectiveType: "2g",
    };
    expect(shouldSkipPrefetch()).toBe(true);
    (navigator as unknown as { connection?: unknown }).connection = original;
  });

  test("false on 4g without saveData", () => {
    const original = (navigator as unknown as { connection?: unknown })
      .connection;
    (navigator as unknown as { connection?: unknown }).connection = {
      effectiveType: "4g",
      saveData: false,
    };
    expect(shouldSkipPrefetch()).toBe(false);
    (navigator as unknown as { connection?: unknown }).connection = original;
  });

  test("false when no connection data", () => {
    const original = (navigator as unknown as { connection?: unknown })
      .connection;
    delete (navigator as unknown as { connection?: unknown }).connection;
    expect(shouldSkipPrefetch()).toBe(false);
    (navigator as unknown as { connection?: unknown }).connection = original;
  });
});

// ---------------------------------------------------------------------------
// warmSubEntrypoint
// ---------------------------------------------------------------------------

function fakeJSResource<T extends object>(): {
  load: () => Promise<T>;
  loadCallCount: () => number;
  moduleId: string;
  getModuleIfRequired: () => T | null;
} {
  let calls = 0;
  return {
    moduleId: "fake",
    getModuleIfRequired: () => null,
    load: () => {
      calls++;
      return Promise.resolve({} as T);
    },
    loadCallCount: () => calls,
  };
}

function fakeSub(
  queries: Record<string, QueryParameter>,
  entryPoints?: Record<string, SubEntryPoint<Record<string, QueryParameter>>>,
): SubEntryPoint<Record<string, QueryParameter>> & {
  rootLoadCount: () => number;
} {
  const root = fakeJSResource();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    root: root as any,
    getPreloadProps: () => ({ queries }),
    entryPoints,
    rootLoadCount: root.loadCallCount,
  };
}

const PRELOAD: PreloadParams = {
  params: {},
  search: new URLSearchParams(),
};

const FAKE_QUERY: QueryParameter = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parameters: { name: "Q1" } as any,
  variables: { x: 1 },
};

describe("warmSubEntrypoint", () => {
  test("loads the sub-entrypoint root and fires its queries", () => {
    loadQueryCalls = [];
    const sub = fakeSub({ q: FAKE_QUERY });
    const refs: PreloadedQuery<never>[] = [];

    warmSubEntrypoint(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      sub,
      PRELOAD,
      refs,
    );

    expect(sub.rootLoadCount()).toBe(1);
    expect(loadQueryCalls.length).toBe(1);
    expect(loadQueryCalls[0]?.variables).toEqual({ x: 1 });
    expect(refs.length).toBe(1);
  });

  test("recursively warms nested sub-entrypoints", () => {
    loadQueryCalls = [];
    const grandchild = fakeSub({ q: FAKE_QUERY });
    const child = fakeSub({ q: FAKE_QUERY }, { grandchild });
    const parent = fakeSub({ q: FAKE_QUERY }, { child });
    const refs: PreloadedQuery<never>[] = [];

    warmSubEntrypoint(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      parent,
      PRELOAD,
      refs,
    );

    // Three modules loaded, three queries fired, three refs retained.
    expect(parent.rootLoadCount()).toBe(1);
    expect(child.rootLoadCount()).toBe(1);
    expect(grandchild.rootLoadCount()).toBe(1);
    expect(loadQueryCalls.length).toBe(3);
    expect(refs.length).toBe(3);
  });

  test("appends to existing refs array (caller's retention bag)", () => {
    loadQueryCalls = [];
    const sub = fakeSub({ q: FAKE_QUERY });
    const refs: PreloadedQuery<never>[] = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { dispose: () => {} } as any,
    ];

    warmSubEntrypoint(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      sub,
      PRELOAD,
      refs,
    );

    expect(refs.length).toBe(2);
  });

  test("a sub-entrypoint with multiple queries fires each one", () => {
    loadQueryCalls = [];
    const sub = fakeSub({
      a: { ...FAKE_QUERY, variables: { id: "a" } },
      b: { ...FAKE_QUERY, variables: { id: "b" } },
      c: { ...FAKE_QUERY, variables: { id: "c" } },
    });
    const refs: PreloadedQuery<never>[] = [];

    warmSubEntrypoint(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      sub,
      PRELOAD,
      refs,
    );

    expect(loadQueryCalls.length).toBe(3);
    expect(refs.length).toBe(3);
    const variables = loadQueryCalls.map((c) => c.variables);
    expect(variables).toContainEqual({ id: "a" });
    expect(variables).toContainEqual({ id: "b" });
    expect(variables).toContainEqual({ id: "c" });
  });
});
