import { describe, expect, test } from "bun:test";
import { validateSearchParams } from "./search-params.ts";

// Build a minimal Standard Schema implementation for testing.
function makeSchema<T>(
  validate: (input: unknown) =>
    | { value: T }
    | { issues: ReadonlyArray<{ path: ReadonlyArray<unknown> }> },
): import("@standard-schema/spec").StandardSchemaV1<unknown, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate,
    },
  } as unknown as import("@standard-schema/spec").StandardSchemaV1<unknown, T>;
}

describe("validateSearchParams", () => {
  test("returns the validator's value when input is valid", () => {
    const schema = makeSchema<{ a: string }>((input) => ({
      value: input as { a: string },
    }));
    const params = new URLSearchParams("a=1");
    expect(validateSearchParams(schema, params)).toEqual({ a: "1" });
  });

  test("drops a single offending key and re-validates", () => {
    let calls = 0;
    const schema = makeSchema((input) => {
      calls++;
      const obj = input as Record<string, unknown>;
      if ("bad" in obj) return { issues: [{ path: ["bad"] }] };
      return { value: obj };
    });
    const params = new URLSearchParams("good=1&bad=2");
    expect(validateSearchParams(schema, params)).toEqual({ good: "1" });
    expect(calls).toBe(2); // initial + retry
  });

  test("returns {} when whole-input fails with no path information", () => {
    const schema = makeSchema(() => ({
      issues: [{ path: [] as ReadonlyArray<unknown> }],
    }));
    const params = new URLSearchParams("a=1");
    expect(validateSearchParams(schema, params)).toEqual({});
  });

  test("returns {} when even the filtered input still fails", () => {
    const schema = makeSchema((input) => {
      const obj = input as Record<string, unknown>;
      if (Object.keys(obj).length === 0) {
        return { issues: [{ path: [] as ReadonlyArray<unknown> }] };
      }
      return { issues: [{ path: ["a"] }] };
    });
    const params = new URLSearchParams("a=1");
    expect(validateSearchParams(schema, params)).toEqual({});
  });

  test("handles validators that throw without crashing the render", () => {
    const schema = makeSchema(() => {
      throw new Error("schema crashed");
    });
    const params = new URLSearchParams("a=1");
    expect(validateSearchParams(schema, params)).toEqual({});
  });

  test("handles object-shaped path entries (per Standard Schema spec)", () => {
    const schema = makeSchema((input) => {
      const obj = input as Record<string, unknown>;
      if ("bad" in obj) {
        return {
          issues: [{ path: [{ key: "bad" }] }],
        };
      }
      return { value: obj };
    });
    const params = new URLSearchParams("good=1&bad=2");
    expect(validateSearchParams(schema, params)).toEqual({ good: "1" });
  });
});
