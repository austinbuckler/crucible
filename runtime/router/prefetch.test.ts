/// <reference lib="dom" />
import { describe, expect, test } from "bun:test";

import { PREFETCH_TTL_MS, shouldSkipPrefetch } from "./prefetch.ts";
import { bucketRoutes } from "./buckets.ts";
import { matchRoute } from "./match.ts";
import { collectPrefetchMatches } from "./use-prefetch-cache.ts";
import { makeRoute } from "./test-fixtures.ts";

describe("PREFETCH_TTL_MS", () => {
  test("is sane (>= 1s, <= 5min)", () => {
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

describe("collectPrefetchMatches", () => {
  test("collects main and matching parallel slot routes", () => {
    const main = makeRoute([{ kind: "literal", value: "dashboard" }]);
    const sidebar = makeRoute([{ kind: "literal", value: "dashboard" }], {
      slot: "sidebar",
    });
    const buckets = bucketRoutes([main, sidebar]);

    const matches = collectPrefetchMatches(buckets, "/dashboard", matchRoute);

    expect(matches.map((m) => m.route)).toEqual([main, sidebar]);
  });

  test("collects intercept and regular slot matches so soft-nav prefetch is warm", () => {
    const main = makeRoute([{ kind: "literal", value: "photos" }]);
    const intercept = makeRoute([{ kind: "literal", value: "photos" }], {
      slot: "dialog",
      intercept: ".",
    });
    const regular = makeRoute([{ kind: "literal", value: "photos" }], {
      slot: "dialog",
    });
    const buckets = bucketRoutes([main, intercept, regular]);

    const matches = collectPrefetchMatches(buckets, "/photos", matchRoute);

    expect(matches.map((m) => m.route)).toEqual([main, intercept, regular]);
  });
});
