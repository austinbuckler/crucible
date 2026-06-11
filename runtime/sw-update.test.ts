/// <reference lib="dom" />
import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import {
  initSwUpdate,
  _internals,
  type Clock,
  type SwUpdateReadyEventDetail,
} from "./sw-update.ts";

// ---------------------------------------------------------------------------
// Stubs for the SW APIs (happydom doesn't ship these by default).
// ---------------------------------------------------------------------------

type EventMap = Map<string, Set<(e: Event) => void>>;

class StubWorker extends EventTarget {
  state: ServiceWorkerState = "installing";
  postMessage = mock((_msg: unknown) => {});
  // Track when state changes so we can fire 'statechange' deterministically.
  setState(next: ServiceWorkerState): void {
    this.state = next;
    this.dispatchEvent(new Event("statechange"));
  }
}

class StubRegistration extends EventTarget {
  installing: StubWorker | null = null;
  waiting: StubWorker | null = null;
  active: StubWorker | null = null;
  update = mock(async () => {});
  unregister = mock(async () => true);

  fireUpdateFound(): void {
    this.dispatchEvent(new Event("updatefound"));
  }
}

type StubServiceWorkerContainer = EventTarget & {
  controller: ServiceWorker | null;
  register: ReturnType<typeof mock>;
};

function installSwStub(): {
  container: StubServiceWorkerContainer;
  registration: StubRegistration;
  registerCalls: Array<{ url: string; opts: RegistrationOptions | undefined }>;
  resolveRegister: () => void;
  rejectRegister: (err: unknown) => void;
  fireControllerChange: () => void;
  setController: (c: ServiceWorker | null) => void;
} {
  const registration = new StubRegistration();
  const registerCalls: Array<{ url: string; opts: RegistrationOptions | undefined }> = [];
  let resolver: () => void = () => {};
  let rejecter: (err: unknown) => void = () => {};
  const registerMock = mock((url: string, opts?: RegistrationOptions) => {
    registerCalls.push({ url, opts });
    return new Promise<StubRegistration>((res, rej) => {
      resolver = () => res(registration);
      rejecter = (err) => rej(err);
    });
  });

  const target = new EventTarget();
  const container: StubServiceWorkerContainer = Object.assign(target, {
    controller: null as ServiceWorker | null,
    register: registerMock,
  });

  const original = (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
  Object.defineProperty(navigator, "serviceWorker", {
    value: container,
    configurable: true,
    writable: true,
  });

  // Restore on the next afterEach via a bookkeeping handle.
  swStubRestoreHandlers.push(() => {
    if (original === undefined) {
      delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    } else {
      Object.defineProperty(navigator, "serviceWorker", {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  });

  return {
    container,
    registration,
    registerCalls,
    resolveRegister: () => resolver(),
    rejectRegister: (err) => rejecter(err),
    fireControllerChange: () => container.dispatchEvent(new Event("controllerchange")),
    setController: (c) => {
      (container as { controller: ServiceWorker | null }).controller = c;
    },
  };
}

const swStubRestoreHandlers: Array<() => void> = [];

// Drain enough microtasks to let .then() chains run. Two awaits is
// usually enough, but we drain four for safety against any wrapping
// promise libraries.
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  while (swStubRestoreHandlers.length > 0) {
    swStubRestoreHandlers.pop()?.();
  }
});

// ---------------------------------------------------------------------------
// Fake clock: deterministic setTimeout / now.
// ---------------------------------------------------------------------------

function makeFakeClock(): Clock & {
  advance: (ms: number) => void;
  pendingCount: () => number;
} {
  type Pending = { id: number; fireAt: number; cb: () => void; cancelled: boolean };
  let now = 0;
  let nextId = 1;
  const pending: Pending[] = [];

  return {
    now: () => now,
    setTimeout: (cb, ms) => {
      const entry: Pending = { id: nextId++, fireAt: now + ms, cb, cancelled: false };
      pending.push(entry);
      return entry.id;
    },
    clearTimeout: (handle) => {
      const id = handle as number;
      const entry = pending.find((p) => p.id === id);
      if (entry) entry.cancelled = true;
    },
    advance: (ms) => {
      const target = now + ms;
      // Sort by fireAt so we fire timers in order even if multiple sit
      // within the advance window.
      pending.sort((a, b) => a.fireAt - b.fireAt);
      while (true) {
        const next = pending.find((p) => !p.cancelled && p.fireAt <= target);
        if (!next) break;
        now = next.fireAt;
        next.cancelled = true;
        next.cb();
      }
      now = target;
    },
    pendingCount: () => pending.filter((p) => !p.cancelled).length,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Each test starts with the tab visible.
  Object.defineProperty(document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
});

describe("initSwUpdate — registration", () => {
  test("calls register() with updateViaCache: 'none' (P0 fix)", async () => {
    const stub = installSwStub();
    const teardown = initSwUpdate({ swUrl: "/sw.js" }, makeFakeClock());

    expect(stub.registerCalls).toHaveLength(1);
    expect(stub.registerCalls[0]?.url).toBe("/sw.js");
    expect(stub.registerCalls[0]?.opts?.updateViaCache).toBe("none");

    stub.resolveRegister();
    await flushMicrotasks();
    teardown();
  });

  test("rejection routes through opts.onSwError", async () => {
    const stub = installSwStub();
    const onSwError = mock((_err: unknown) => {});
    const teardown = initSwUpdate(
      { swUrl: "/sw.js", onSwError },
      makeFakeClock(),
    );

    const err = new Error("boom");
    stub.rejectRegister(err);
    // Allow the .catch handler to run.
    await Promise.resolve();
    await Promise.resolve();

    expect(onSwError).toHaveBeenCalledTimes(1);
    expect(onSwError.mock.calls[0]?.[0]).toBe(err);
    teardown();
  });

  test("rejection without onSwError falls back to console.error (no throw)", async () => {
    const stub = installSwStub();
    const originalError = console.error;
    const errSpy = mock((..._args: unknown[]) => {});
    console.error = errSpy;
    try {
      const teardown = initSwUpdate({ swUrl: "/sw.js" }, makeFakeClock());
      stub.rejectRegister(new Error("boom"));
      await Promise.resolve();
      await Promise.resolve();
      expect(errSpy).toHaveBeenCalled();
      teardown();
    } finally {
      console.error = originalError;
    }
  });
});

describe("initSwUpdate — update detection", () => {
  test("dispatches crucible:update-ready when installing → installed (with prior controller)", async () => {
    const stub = installSwStub();
    // Simulate: page loaded with an active SW already in control.
    stub.setController({} as ServiceWorker);

    let receivedDetail: SwUpdateReadyEventDetail | null = null;
    const handler = (e: Event): void => {
      receivedDetail = (e as CustomEvent<SwUpdateReadyEventDetail>).detail;
    };
    window.addEventListener(_internals.UPDATE_READY_EVENT, handler);

    const onUpdateReady = mock((_e: SwUpdateReadyEventDetail) => {});
    const teardown = initSwUpdate(
      { swUrl: "/sw.js", onUpdateReady, idleThresholdMs: Infinity },
      makeFakeClock(),
    );
    stub.resolveRegister();
    await flushMicrotasks();

    // Simulate: new SW installs.
    const installing = new StubWorker();
    stub.registration.installing = installing;
    stub.registration.fireUpdateFound();
    installing.setState("installed");

    // Both signals fire.
    expect(receivedDetail).not.toBeNull();
    expect(typeof receivedDetail!.activate).toBe("function");
    expect(onUpdateReady).toHaveBeenCalledTimes(1);

    window.removeEventListener(_internals.UPDATE_READY_EVENT, handler);
    teardown();
  });

  test("activate() posts crucible:skip-waiting to the waiting worker", async () => {
    const stub = installSwStub();
    stub.setController({} as ServiceWorker);
    const onUpdateReady = mock((_e: SwUpdateReadyEventDetail) => {});
    const teardown = initSwUpdate(
      { swUrl: "/sw.js", onUpdateReady, idleThresholdMs: Infinity },
      makeFakeClock(),
    );
    stub.resolveRegister();
    await flushMicrotasks();

    const installing = new StubWorker();
    stub.registration.installing = installing;
    stub.registration.fireUpdateFound();
    // After install completes the worker becomes the registration's
    // `waiting`; mirror that.
    stub.registration.waiting = installing;
    installing.setState("installed");

    const detail = onUpdateReady.mock.calls[0]?.[0] as SwUpdateReadyEventDetail;
    detail.activate();

    expect(installing.postMessage).toHaveBeenCalledTimes(1);
    expect(installing.postMessage.mock.calls[0]?.[0]).toBe(
      _internals.SKIP_WAITING_MESSAGE,
    );

    // activate() is idempotent — second call is a no-op.
    detail.activate();
    expect(installing.postMessage).toHaveBeenCalledTimes(1);

    teardown();
  });

  test("does NOT signal update-ready on first install (no prior controller)", async () => {
    const stub = installSwStub();
    // No controller — first install scenario.
    const onUpdateReady = mock((_e: SwUpdateReadyEventDetail) => {});
    const teardown = initSwUpdate(
      { swUrl: "/sw.js", onUpdateReady, idleThresholdMs: Infinity },
      makeFakeClock(),
    );
    stub.resolveRegister();
    await flushMicrotasks();

    const installing = new StubWorker();
    stub.registration.installing = installing;
    stub.registration.fireUpdateFound();
    installing.setState("installed");
    // Without controller the SW proceeds straight to activated; no
    // update-ready signal should fire (this is the first install).
    expect(onUpdateReady).not.toHaveBeenCalled();
    teardown();
  });
});

describe("initSwUpdate — registration.update() polling", () => {
  test("polls update() on visibilitychange to visible", async () => {
    const stub = installSwStub();
    stub.setController({} as ServiceWorker);
    const teardown = initSwUpdate(
      { swUrl: "/sw.js", idleThresholdMs: Infinity },
      makeFakeClock(),
    );
    stub.resolveRegister();
    await flushMicrotasks();

    document.dispatchEvent(new Event("visibilitychange"));
    expect(stub.registration.update).toHaveBeenCalledTimes(1);

    teardown();
  });

  test("polling is throttled to once per UPDATE_POLL_THROTTLE_MS", async () => {
    const stub = installSwStub();
    stub.setController({} as ServiceWorker);
    const clock = makeFakeClock();
    const teardown = initSwUpdate(
      { swUrl: "/sw.js", idleThresholdMs: Infinity },
      clock,
    );
    stub.resolveRegister();
    await flushMicrotasks();

    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(stub.registration.update).toHaveBeenCalledTimes(1);

    // Advance just under the throttle window — still throttled.
    clock.advance(_internals.UPDATE_POLL_THROTTLE_MS - 1);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(stub.registration.update).toHaveBeenCalledTimes(1);

    // Cross the threshold — next call lands.
    clock.advance(2);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(stub.registration.update).toHaveBeenCalledTimes(2);

    teardown();
  });

  test("polls on focus event", async () => {
    const stub = installSwStub();
    stub.setController({} as ServiceWorker);
    const teardown = initSwUpdate(
      { swUrl: "/sw.js", idleThresholdMs: Infinity },
      makeFakeClock(),
    );
    stub.resolveRegister();
    await flushMicrotasks();

    window.dispatchEvent(new Event("focus"));
    expect(stub.registration.update).toHaveBeenCalledTimes(1);
    teardown();
  });
});

describe("initSwUpdate — idle auto-activate", () => {
  test("idle timer fires activate() after idleThresholdMs", async () => {
    const stub = installSwStub();
    stub.setController({} as ServiceWorker);
    const clock = makeFakeClock();
    const teardown = initSwUpdate(
      { swUrl: "/sw.js", idleThresholdMs: 1000 },
      clock,
    );
    stub.resolveRegister();
    await flushMicrotasks();

    const installing = new StubWorker();
    stub.registration.installing = installing;
    stub.registration.waiting = installing;
    stub.registration.fireUpdateFound();
    installing.setState("installed");

    expect(installing.postMessage).not.toHaveBeenCalled();

    // Advance past the idle threshold — activate() fires automatically.
    clock.advance(1001);
    expect(installing.postMessage).toHaveBeenCalledTimes(1);

    teardown();
  });

  test("input event resets the idle timer", async () => {
    const stub = installSwStub();
    stub.setController({} as ServiceWorker);
    const clock = makeFakeClock();
    const teardown = initSwUpdate(
      { swUrl: "/sw.js", idleThresholdMs: 1000 },
      clock,
    );
    stub.resolveRegister();
    await flushMicrotasks();

    const installing = new StubWorker();
    stub.registration.installing = installing;
    stub.registration.waiting = installing;
    stub.registration.fireUpdateFound();
    installing.setState("installed");

    // Halfway through the idle window, the user moves the mouse.
    clock.advance(500);
    document.dispatchEvent(new Event("mousemove"));

    // Another 600ms — would have fired without reset, but reset means
    // the timer needs another full 1000ms from this point.
    clock.advance(600);
    expect(installing.postMessage).not.toHaveBeenCalled();

    // 500 more — total 1100 from reset, past threshold.
    clock.advance(500);
    expect(installing.postMessage).toHaveBeenCalledTimes(1);

    teardown();
  });

  test("hidden tab activates immediately (fast path)", async () => {
    const stub = installSwStub();
    stub.setController({} as ServiceWorker);
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    const teardown = initSwUpdate(
      { swUrl: "/sw.js", idleThresholdMs: 5_000 },
      makeFakeClock(),
    );
    stub.resolveRegister();
    await flushMicrotasks();

    const installing = new StubWorker();
    stub.registration.installing = installing;
    stub.registration.waiting = installing;
    stub.registration.fireUpdateFound();
    installing.setState("installed");

    // No clock advance — activate fired synchronously because the tab
    // is hidden.
    expect(installing.postMessage).toHaveBeenCalledTimes(1);

    teardown();
  });

  test("idleThresholdMs: Infinity disables auto-activate", async () => {
    const stub = installSwStub();
    stub.setController({} as ServiceWorker);
    const clock = makeFakeClock();
    const onUpdateReady = mock((_e: SwUpdateReadyEventDetail) => {});
    const teardown = initSwUpdate(
      { swUrl: "/sw.js", idleThresholdMs: Infinity, onUpdateReady },
      clock,
    );
    stub.resolveRegister();
    await flushMicrotasks();

    const installing = new StubWorker();
    stub.registration.installing = installing;
    stub.registration.waiting = installing;
    stub.registration.fireUpdateFound();
    installing.setState("installed");

    // Update-ready still fires (event surface unaffected).
    expect(onUpdateReady).toHaveBeenCalledTimes(1);

    // Advance past plausible thresholds — never auto-activates.
    clock.advance(60 * 60 * 1000);
    expect(installing.postMessage).not.toHaveBeenCalled();

    teardown();
  });

  test("visibility hidden mid-wait fires immediate activate", async () => {
    const stub = installSwStub();
    stub.setController({} as ServiceWorker);
    const clock = makeFakeClock();
    const teardown = initSwUpdate(
      { swUrl: "/sw.js", idleThresholdMs: 60_000 },
      clock,
    );
    stub.resolveRegister();
    await flushMicrotasks();

    const installing = new StubWorker();
    stub.registration.installing = installing;
    stub.registration.waiting = installing;
    stub.registration.fireUpdateFound();
    installing.setState("installed");

    // Tab hides mid-wait.
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));

    expect(installing.postMessage).toHaveBeenCalledTimes(1);
    teardown();
  });
});

describe("initSwUpdate — controllerchange reload", () => {
  test("controllerchange triggers window.location.reload (subsequent activation)", async () => {
    const stub = installSwStub();
    stub.setController({} as ServiceWorker);
    const reloadSpy = mock(() => {});
    const originalReload = window.location.reload;
    Object.defineProperty(window.location, "reload", {
      value: reloadSpy,
      configurable: true,
      writable: true,
    });
    try {
      const teardown = initSwUpdate(
        { swUrl: "/sw.js", idleThresholdMs: Infinity },
        makeFakeClock(),
      );
      stub.resolveRegister();
      await Promise.resolve();

      stub.fireControllerChange();
      expect(reloadSpy).toHaveBeenCalledTimes(1);
      teardown();
    } finally {
      Object.defineProperty(window.location, "reload", {
        value: originalReload,
        configurable: true,
        writable: true,
      });
    }
  });

  test("controllerchange does NOT reload on first install (no prior controller)", async () => {
    const stub = installSwStub();
    // No controller — first install.
    const reloadSpy = mock(() => {});
    const originalReload = window.location.reload;
    Object.defineProperty(window.location, "reload", {
      value: reloadSpy,
      configurable: true,
      writable: true,
    });
    try {
      const teardown = initSwUpdate(
        { swUrl: "/sw.js", idleThresholdMs: Infinity },
        makeFakeClock(),
      );
      stub.resolveRegister();
      await Promise.resolve();

      // The first activation fires a controllerchange; we should NOT reload.
      stub.fireControllerChange();
      expect(reloadSpy).not.toHaveBeenCalled();

      // A subsequent change (e.g. an update-driven activation later)
      // SHOULD reload.
      stub.fireControllerChange();
      expect(reloadSpy).toHaveBeenCalledTimes(1);
      teardown();
    } finally {
      Object.defineProperty(window.location, "reload", {
        value: originalReload,
        configurable: true,
        writable: true,
      });
    }
  });
});

describe("initSwUpdate — teardown", () => {
  test("teardown removes all listeners (no further events processed)", async () => {
    const stub = installSwStub();
    stub.setController({} as ServiceWorker);
    const teardown = initSwUpdate(
      { swUrl: "/sw.js", idleThresholdMs: Infinity },
      makeFakeClock(),
    );
    stub.resolveRegister();
    await flushMicrotasks();

    teardown();

    // Visibility events post-teardown should not poll.
    document.dispatchEvent(new Event("visibilitychange"));
    expect(stub.registration.update).not.toHaveBeenCalled();
  });

  test("teardown is idempotent", async () => {
    const stub = installSwStub();
    const teardown = initSwUpdate(
      { swUrl: "/sw.js", idleThresholdMs: Infinity },
      makeFakeClock(),
    );
    stub.resolveRegister();
    await flushMicrotasks();
    teardown();
    expect(() => teardown()).not.toThrow();
  });

  test("teardown before register() resolves does not call watchRegistration", async () => {
    const stub = installSwStub();
    const teardown = initSwUpdate(
      { swUrl: "/sw.js", idleThresholdMs: Infinity },
      makeFakeClock(),
    );
    teardown();
    stub.resolveRegister();
    await flushMicrotasks();
    // Teardown ran before resolution; subsequent visibility events do
    // not poll.
    document.dispatchEvent(new Event("visibilitychange"));
    expect(stub.registration.update).not.toHaveBeenCalled();
  });
});

describe("initSwUpdate — environment guards", () => {
  test("returns no-op teardown when serviceWorker is unavailable", () => {
    const original = (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    Object.defineProperty(navigator, "serviceWorker", {
      value: undefined,
      configurable: true,
    });
    try {
      const teardown = initSwUpdate({ swUrl: "/sw.js" });
      expect(typeof teardown).toBe("function");
      expect(() => teardown()).not.toThrow();
    } finally {
      Object.defineProperty(navigator, "serviceWorker", {
        value: original,
        configurable: true,
      });
    }
  });
});
