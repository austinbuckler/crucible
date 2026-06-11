import { test, expect, describe } from "bun:test";
import { bucketRoutes, byDepthDesc, bySpecificityDesc } from "./buckets.ts";
import type { RouteRecord, RouteSegment } from "./types.ts";

function makeRoute(
  path: string,
  segments: ReadonlyArray<RouteSegment>,
  opts: {
    slot?: string;
    intercept?: string | true;
    kind?: "default";
  } = {},
): RouteRecord {
  return {
    path,
    segments,
    frames: [],
    entrypoint: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      root: { moduleId: "x", load: () => Promise.resolve({}), getModuleIfRequired: () => null } as any,
      getPreloadProps: () => ({ queries: {} }),
    },
    ...opts,
  };
}

describe("byDepthDesc", () => {
  test("sorts longer-segments first", () => {
    const a = makeRoute("/a", [{ kind: "literal", value: "a" }]);
    const b = makeRoute("/a/b/c", [
      { kind: "literal", value: "a" },
      { kind: "literal", value: "b" },
      { kind: "literal", value: "c" },
    ]);
    const sorted = [a, b].sort(byDepthDesc);
    expect(sorted[0]).toBe(b);
    expect(sorted[1]).toBe(a);
  });
});

describe("bucketRoutes", () => {
  test("partitions main pages, defaults, and slot routes", () => {
    const main = makeRoute("/", []);
    const mainDefault = makeRoute("/", [], { kind: "default" });
    const slotPage = makeRoute("/x", [{ kind: "literal", value: "x" }], {
      slot: "modal",
    });
    const slotIntercept = makeRoute("/y", [{ kind: "literal", value: "y" }], {
      slot: "modal",
      intercept: ".",
    });
    const slotDefault = makeRoute("/z", [{ kind: "literal", value: "z" }], {
      slot: "modal",
      kind: "default",
    });

    const b = bucketRoutes([
      main,
      mainDefault,
      slotPage,
      slotIntercept,
      slotDefault,
    ]);
    expect(b.mainRoutes).toEqual([main]);
    expect(b.mainDefaults).toEqual([mainDefault]);
    expect(b.slotRegulars.get("modal")).toEqual([slotPage]);
    expect(b.slotIntercepts.get("modal")).toEqual([slotIntercept]);
    expect(b.slotDefaults.get("modal")).toEqual([slotDefault]);
    expect(b.allSlots).toEqual(["modal"]);
  });

  test("main defaults are sorted deepest-first", () => {
    const shallow = makeRoute("/", [], { kind: "default" });
    const deep = makeRoute("/admin/users", [
      { kind: "literal", value: "admin" },
      { kind: "literal", value: "users" },
    ], { kind: "default" });
    const b = bucketRoutes([shallow, deep]);
    expect(b.mainDefaults[0]).toBe(deep);
    expect(b.mainDefaults[1]).toBe(shallow);
  });

  test("main pages are sorted with literal segments before params at the same position", () => {
    // `/clients/[id]` sits before `/clients/new` on disk because `[`
    // sorts before `n` in `readdirSync` order, but the matcher needs
    // `/clients/new` to win for that URL — exact literal beats a
    // wildcard at the same depth.
    const paramRoute = makeRoute("/clients/[id]", [
      { kind: "literal", value: "clients" },
      { kind: "param", name: "id" },
    ]);
    const literalRoute = makeRoute("/clients/new", [
      { kind: "literal", value: "clients" },
      { kind: "literal", value: "new" },
    ]);
    const b = bucketRoutes([paramRoute, literalRoute]);
    expect(b.mainRoutes[0]).toBe(literalRoute);
    expect(b.mainRoutes[1]).toBe(paramRoute);
  });

  test("bySpecificityDesc breaks ties by walking segments left-to-right", () => {
    const a = makeRoute("/a/[x]", [
      { kind: "literal", value: "a" },
      { kind: "param", name: "x" },
    ]);
    const b = makeRoute("/[y]/b", [
      { kind: "param", name: "y" },
      { kind: "literal", value: "b" },
    ]);
    const sorted = [b, a].sort(bySpecificityDesc);
    expect(sorted[0]).toBe(a);
    expect(sorted[1]).toBe(b);
  });

  test("any truthy intercept goes to slotIntercepts (kind values aren't differentiated)", () => {
    const dot = makeRoute("/x", [{ kind: "literal", value: "x" }], {
      slot: "modal",
      intercept: ".",
    });
    const dotdot = makeRoute("/y", [{ kind: "literal", value: "y" }], {
      slot: "modal",
      intercept: "..",
    });
    const flag = makeRoute("/z", [{ kind: "literal", value: "z" }], {
      slot: "modal",
      intercept: true,
    });
    const b = bucketRoutes([dot, dotdot, flag]);
    expect(b.slotIntercepts.get("modal")).toEqual([dot, dotdot, flag]);
    expect(b.slotRegulars.get("modal")).toBeUndefined();
  });
});
