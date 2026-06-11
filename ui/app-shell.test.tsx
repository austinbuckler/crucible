/// <reference lib="dom" />
import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { render, cleanup } from "@testing-library/react";

// Stub `import.meta.env.CRUCIBLE_SW_URL` so AppShell's effect runs the
// SW path. The plugin sets this at build time; in tests we need to set
// it BEFORE the AppShell module loads.
(import.meta.env as unknown as Record<string, unknown>).CRUCIBLE_SW_URL = "/sw.js";
(import.meta.env as unknown as Record<string, unknown>).CRUCIBLE_MANIFEST_URL = null;

// Stub navigator.serviceWorker so initSwUpdate's registration path works
// against happydom (which doesn't ship a SW container by default).
type StubContainer = EventTarget & {
  controller: ServiceWorker | null;
  register: ReturnType<typeof mock>;
};

function installSwContainer(): {
  container: StubContainer;
  registerCalls: Array<{ url: string; opts: RegistrationOptions | undefined }>;
} {
  const target = new EventTarget();
  const calls: Array<{ url: string; opts: RegistrationOptions | undefined }> = [];
  const registerMock = mock((url: string, opts?: RegistrationOptions) => {
    calls.push({ url, opts });
    // Never resolves; we don't need the post-resolution path for these
    // tests — we only care that swUpdate options threaded through.
    return new Promise(() => {});
  });
  const container: StubContainer = Object.assign(target, {
    controller: null as ServiceWorker | null,
    register: registerMock,
  });
  Object.defineProperty(navigator, "serviceWorker", {
    value: container,
    configurable: true,
    writable: true,
  });
  return { container, registerCalls: calls };
}

let stub: ReturnType<typeof installSwContainer> | null = null;

beforeEach(() => {
  cleanup();
  stub = installSwContainer();
});

afterEach(() => {
  cleanup();
  if (stub) {
    Object.defineProperty(navigator, "serviceWorker", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    stub = null;
  }
});

// Import AFTER the env stub is set so `import.meta.env.CRUCIBLE_SW_URL`
// resolves to the value we want.
const { AppShell } = await import("./app-shell.tsx");

describe("AppShell — swUpdate prop wiring", () => {
  test("default mount registers /sw.js with updateViaCache: 'none' (P0 default)", () => {
    render(<AppShell>{null}</AppShell>);
    expect(stub!.registerCalls).toHaveLength(1);
    expect(stub!.registerCalls[0]?.url).toBe("/sw.js");
    expect(stub!.registerCalls[0]?.opts?.updateViaCache).toBe("none");
  });

  test("mount with no swUpdate prop still registers (defaults apply)", () => {
    render(<AppShell>{null}</AppShell>);
    expect(stub!.registerCalls).toHaveLength(1);
  });

  test("mount with swUpdate.idleThresholdMs registers normally (config consumed by initSwUpdate)", () => {
    // The idle threshold is consumed inside initSwUpdate; from the
    // AppShell side, the visible side-effect is that register() is
    // still called with the right URL + options. The detailed
    // threshold semantics are covered in sw-update.test.ts.
    render(
      <AppShell swUpdate={{ idleThresholdMs: 60_000 }}>{null}</AppShell>,
    );
    expect(stub!.registerCalls).toHaveLength(1);
    expect(stub!.registerCalls[0]?.opts?.updateViaCache).toBe("none");
  });

  test("idleThresholdMs: Infinity is the documented opt-out for auto-activate", () => {
    // Pin the API contract: passing Infinity must not throw and must
    // still register the SW.
    render(
      <AppShell swUpdate={{ idleThresholdMs: Infinity }}>{null}</AppShell>,
    );
    expect(stub!.registerCalls).toHaveLength(1);
  });

  test("onSwError is captured by initSwUpdate (no throw on rejection)", () => {
    const onSwError = mock(() => {});
    expect(() => {
      render(<AppShell swUpdate={{ onSwError }}>{null}</AppShell>);
    }).not.toThrow();
    expect(stub!.registerCalls).toHaveLength(1);
  });

  test("re-rendering with a new swUpdate prop re-initializes (register fires again)", () => {
    const { rerender } = render(
      <AppShell swUpdate={{ idleThresholdMs: 60_000 }}>{null}</AppShell>,
    );
    expect(stub!.registerCalls).toHaveLength(1);
    rerender(
      <AppShell swUpdate={{ idleThresholdMs: 120_000 }}>{null}</AppShell>,
    );
    expect(stub!.registerCalls).toHaveLength(2);
  });

  test("unmount does not throw (teardown runs cleanly)", () => {
    const { unmount } = render(<AppShell>{null}</AppShell>);
    expect(() => unmount()).not.toThrow();
  });
});
