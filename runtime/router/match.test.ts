import { test, expect, describe } from "bun:test";
import { matchRoute, matchDefault } from "./match.ts";
import type { RouteRecord, RouteSegment } from "./types.ts";

// Minimal RouteRecord factory — `frames` and `entrypoint` aren't read by
// the pure matching helpers, so empty stubs are fine for these tests.
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

describe("matchRoute — literal segments", () => {
  test("exact match", () => {
    const r = makeRoute("/orders", [{ kind: "literal", value: "orders" }]);
    const m = matchRoute([r], "/orders");
    expect(m?.route).toBe(r);
    expect(m?.params).toEqual({});
  });

  test("trailing path rejects", () => {
    const r = makeRoute("/orders", [{ kind: "literal", value: "orders" }]);
    expect(matchRoute([r], "/orders/123")).toBe(null);
  });

  test("partial path rejects", () => {
    const r = makeRoute("/orders/new", [
      { kind: "literal", value: "orders" },
      { kind: "literal", value: "new" },
    ]);
    expect(matchRoute([r], "/orders")).toBe(null);
  });

  test("first matching wins", () => {
    const a = makeRoute("/orders", [{ kind: "literal", value: "orders" }]);
    const b = makeRoute("/orders", [{ kind: "literal", value: "orders" }]);
    expect(matchRoute([a, b], "/orders")?.route).toBe(a);
  });
});

describe("matchRoute — params and catchall", () => {
  test("param binds and decodes", () => {
    const r = makeRoute("/orders/[id]", [
      { kind: "literal", value: "orders" },
      { kind: "param", name: "id" },
    ]);
    expect(matchRoute([r], "/orders/abc-123")?.params).toEqual({
      id: "abc-123",
    });
  });

  test("param decodes percent-encoding", () => {
    const r = makeRoute("/c/[name]", [
      { kind: "literal", value: "c" },
      { kind: "param", name: "name" },
    ]);
    expect(matchRoute([r], "/c/hello%20world")?.params).toEqual({
      name: "hello world",
    });
  });

  test("malformed percent-encoding fails the match instead of throwing", () => {
    const r = makeRoute("/c/[name]", [
      { kind: "literal", value: "c" },
      { kind: "param", name: "name" },
    ]);
    expect(() => matchRoute([r], "/c/%E0%A4")).not.toThrow();
    expect(matchRoute([r], "/c/%E0%A4")).toBe(null);
  });

  test("catchall consumes remaining segments", () => {
    const r = makeRoute("/docs/[...path]", [
      { kind: "literal", value: "docs" },
      { kind: "catchall", name: "path" },
    ]);
    expect(matchRoute([r], "/docs/a/b/c")?.params).toEqual({
      path: "a/b/c",
    });
  });

  test("catchall matches empty tail", () => {
    const r = makeRoute("/docs/[...path]", [
      { kind: "literal", value: "docs" },
      { kind: "catchall", name: "path" },
    ]);
    expect(matchRoute([r], "/docs")?.params).toEqual({ path: "" });
  });
});

describe("matchDefault — prefix match", () => {
  test("exact-depth match", () => {
    const r = makeRoute("/dashboard", [
      { kind: "literal", value: "dashboard" },
    ], { kind: "default" });
    expect(matchDefault([r], "/dashboard")?.route).toBe(r);
  });

  test("deeper URL still matches the prefix default", () => {
    const r = makeRoute("/dashboard", [
      { kind: "literal", value: "dashboard" },
    ], { kind: "default" });
    expect(matchDefault([r], "/dashboard/settings/account")?.route).toBe(r);
  });

  test("URL shorter than route segments rejects", () => {
    const r = makeRoute("/dashboard/settings", [
      { kind: "literal", value: "dashboard" },
      { kind: "literal", value: "settings" },
    ], { kind: "default" });
    expect(matchDefault([r], "/dashboard")).toBe(null);
  });

  test("dynamic param on default still binds", () => {
    const r = makeRoute("/orgs/[id]", [
      { kind: "literal", value: "orgs" },
      { kind: "param", name: "id" },
    ], { kind: "default" });
    expect(matchDefault([r], "/orgs/abc/teams/x")?.params).toEqual({
      id: "abc",
    });
  });

  test("first listed default wins (caller pre-sorts deepest-first)", () => {
    const shallow = makeRoute("/", [], { kind: "default" });
    const deep = makeRoute("/admin", [
      { kind: "literal", value: "admin" },
    ], { kind: "default" });
    // intentionally deepest-first per bucketRoutes' contract
    expect(matchDefault([deep, shallow], "/admin/users")?.route).toBe(deep);
    expect(matchDefault([deep, shallow], "/customers")?.route).toBe(shallow);
  });
});

describe("matchRoute / matchDefault — adversarial inputs", () => {
  // The router treats malformed inputs as "no match" rather than
  // throwing. A regression here would crash the render on any URL the
  // user pastes from a careless email link or a shortened URL service.
  const r = makeRoute("/orders/[id]", [
    { kind: "literal", value: "orders" },
    { kind: "param", name: "id" },
  ]);

  test("malformed percent-encoding never throws (returns no-match)", () => {
    const inputs = [
      "/orders/%E0",
      "/orders/%FF%FE%FD",
      "/orders/%",
      "/orders/%2",
      "/orders/%g0",
      "/orders/" + "%C0".repeat(1000),
    ];
    for (const path of inputs) {
      expect(() => matchRoute([r], path)).not.toThrow();
      expect(() => matchDefault([r], path)).not.toThrow();
    }
  });

  test("path with embedded NUL byte (encoded) — handled, doesn't crash", () => {
    const result = matchRoute([r], "/orders/%00");
    if (result !== null) {
      expect(typeof result.params.id).toBe("string");
    }
  });

  test("very long pathname (1MB) — linear-time match, no OOM", () => {
    const longSegment = "a".repeat(1_000_000);
    const start = Date.now();
    const result = matchRoute([r], "/orders/" + longSegment);
    expect(result?.params.id).toBe(longSegment);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  test("thousands of segments — no match, no crash", () => {
    const path = "/" + Array(10_000).fill("x").join("/");
    expect(() => matchRoute([r], path)).not.toThrow();
    expect(matchRoute([r], path)).toBeNull();
  });

  test("empty / root path matches a zero-segment route", () => {
    const root = makeRoute("/", []);
    expect(matchRoute([root], "/")?.route).toBe(root);
    expect(matchRoute([root], "")?.route).toBe(root);
  });

  test("empty routes array returns null — never crashes", () => {
    expect(matchRoute([], "/anything")).toBeNull();
    expect(matchDefault([], "/anything")).toBeNull();
  });
});
