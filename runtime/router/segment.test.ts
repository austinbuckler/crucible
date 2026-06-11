import { describe, expect, test } from "bun:test";
import {
  segmentValue,
  selectedChildSegment,
  selectedSlotSegment,
} from "./segment.ts";
import type { Match, RouteRecord } from "./types.ts";

// Minimal Match factory — `frames` and `entrypoint` are unused by the
// segment helpers, so empty stubs are fine.
function makeMatch(
  segments: Match["route"]["segments"],
  params: Record<string, string> = {},
): Match {
  const route: RouteRecord = {
    path: "/" + segments.map((s) =>
      s.kind === "literal" ? s.value :
      s.kind === "param" ? `[${s.name}]` : `[...${s.name}]`,
    ).join("/"),
    segments,
    frames: [],
    entrypoint: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      root: { moduleId: "x", load: () => Promise.resolve({}), getModuleIfRequired: () => null } as any,
      getPreloadProps: () => ({ queries: {} }),
    },
  };
  return { route, params };
}

describe("segmentValue", () => {
  test("returns literal value for literal segments", () => {
    expect(segmentValue({ kind: "literal", value: "orders" }, {})).toBe(
      "orders",
    );
  });

  test("returns bound param value for param segments", () => {
    expect(
      segmentValue({ kind: "param", name: "id" }, { id: "abc-123" }),
    ).toBe("abc-123");
  });

  test("returns bound catchall value", () => {
    expect(
      segmentValue({ kind: "catchall", name: "rest" }, { rest: "a/b/c" }),
    ).toBe("a/b/c");
  });

  test("returns null when a param's binding is missing", () => {
    expect(segmentValue({ kind: "param", name: "id" }, {})).toBe(null);
  });
});

describe("selectedChildSegment — no-arg useSelectedLayoutSegment semantics", () => {
  test("returns segment immediately below the calling layout's URL position", () => {
    // Match for /orders/abc — layout at root (depth 0) sees "orders".
    const match = makeMatch(
      [
        { kind: "literal", value: "orders" },
        { kind: "param", name: "id" },
      ],
      { id: "abc" },
    );
    expect(selectedChildSegment(match, 0)).toBe("orders");
  });

  test("returns the param-bound value when the next segment is dynamic", () => {
    // Layout at /orders (depth 1) — segment at index 1 is the [id] param.
    const match = makeMatch(
      [
        { kind: "literal", value: "orders" },
        { kind: "param", name: "id" },
      ],
      { id: "abc" },
    );
    expect(selectedChildSegment(match, 1)).toBe("abc");
  });

  test("returns null when no descendant page is active under the layout", () => {
    // Layout at /orders/[id] (depth 2), but the URL stops at /orders/abc.
    const match = makeMatch(
      [
        { kind: "literal", value: "orders" },
        { kind: "param", name: "id" },
      ],
      { id: "abc" },
    );
    expect(selectedChildSegment(match, 2)).toBe(null);
  });

  test("returns null when match itself is null (pre-resolution)", () => {
    expect(selectedChildSegment(null, 0)).toBe(null);
  });
});

describe("selectedSlotSegment — slot-arg useSelectedLayoutSegment semantics", () => {
  test("returns the LAST segment of the slot's match (mirrors Next.js)", () => {
    // Slot match for /orders/new — Next returns `segments[length - 1]`
    // for non-children parallel routes. Crucible's slot routes carry the
    // full URL path, so the last segment is what the consumer wants.
    const match = makeMatch([
      { kind: "literal", value: "orders" },
      { kind: "literal", value: "new" },
    ]);
    expect(selectedSlotSegment(match)).toBe("new");
  });

  test("returns the param-bound value when the slot's last segment is dynamic", () => {
    const match = makeMatch(
      [
        { kind: "literal", value: "settings" },
        { kind: "param", name: "product" },
        { kind: "literal", value: "respond" },
        { kind: "param", name: "lineId" },
      ],
      { product: "p-1", lineId: "l-99" },
    );
    expect(selectedSlotSegment(match)).toBe("l-99");
  });

  test("returns null when the slot has no active page", () => {
    expect(selectedSlotSegment(null)).toBe(null);
  });

  test("returns null when the slot match has no segments (root-level slot)", () => {
    const match = makeMatch([]);
    expect(selectedSlotSegment(match)).toBe(null);
  });
});
