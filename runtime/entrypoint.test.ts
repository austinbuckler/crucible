import { test, expect, describe } from "bun:test";
import { JSResource } from "./entrypoint.ts";

describe("JSResource", () => {
  test("getModuleIfRequired returns null before load", () => {
    const r = JSResource("a", () => Promise.resolve({ default: 1 }));
    expect(r.getModuleIfRequired()).toBe(null);
  });

  test("load resolves and caches", async () => {
    const mod = { default: 42 };
    let calls = 0;
    const r = JSResource("a", async () => {
      calls++;
      return mod;
    });
    expect(await r.load()).toBe(mod);
    expect(r.getModuleIfRequired()).toBe(mod);
    // second load returns cached without re-invoking loader
    expect(await r.load()).toBe(mod);
    expect(calls).toBe(1);
  });

  test("concurrent load() calls share the same in-flight promise", async () => {
    let calls = 0;
    let resolveLoader!: (m: { default: number }) => void;
    const r = JSResource(
      "a",
      () =>
        new Promise<{ default: number }>((resolve) => {
          calls++;
          resolveLoader = resolve;
        }),
    );
    const p1 = r.load();
    const p2 = r.load();
    expect(p1).toBe(p2);
    expect(calls).toBe(1);
    resolveLoader({ default: 1 });
    await p1;
  });

  test("rejection clears pending so retry re-invokes the loader", async () => {
    let attempt = 0;
    const r = JSResource("a", async () => {
      attempt++;
      if (attempt === 1) throw new Error("boom");
      return { default: "ok" };
    });
    await expect(r.load()).rejects.toThrow("boom");
    // KEY behavior: after rejection, retry must call the loader again. The
    // pre-fix bug returned the same rejected promise forever, breaking the
    // ErrorBoundary "Try again" path.
    const result = await r.load();
    expect(result).toEqual({ default: "ok" });
    expect(attempt).toBe(2);
  });

  test("late retry after rejection still works", async () => {
    let attempt = 0;
    const r = JSResource("a", async () => {
      attempt++;
      if (attempt < 3) throw new Error(`fail-${attempt}`);
      return { default: "finally" };
    });
    await expect(r.load()).rejects.toThrow("fail-1");
    await expect(r.load()).rejects.toThrow("fail-2");
    expect(await r.load()).toEqual({ default: "finally" });
    expect(attempt).toBe(3);
  });

  test("getModuleIfRequired stays null after rejection", async () => {
    const r = JSResource("a", async () => {
      throw new Error("nope");
    });
    await expect(r.load()).rejects.toThrow();
    expect(r.getModuleIfRequired()).toBe(null);
  });
});
