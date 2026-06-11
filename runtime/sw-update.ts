/// <reference lib="dom" />

// SW update lifecycle manager. Pure side-effect module (no React, no
// global state). `<AppShell>` calls `initSwUpdate(opts)` from a useEffect
// and stores the returned teardown for cleanup on unmount.
//
// Responsibilities (the four bug clusters from sw-update-investigation.md):
//
//   #25 P0: register() with updateViaCache: 'none' so the browser doesn't
//           serve a stale /sw.js from HTTP cache.
//
//   #26 P1: defer activation — the SW template no longer calls
//           skipWaiting() in install, so a new SW lands in `waiting`.
//           This module:
//             a. polls registration.update() on visibility/focus
//                (throttled to once per 60 s).
//             b. listens for `updatefound` → `installing.statechange ===
//                'installed'` → arms the waiting-SW path.
//             c. dispatches `crucible:update-ready` on window with an
//                `activate()` callback in event detail; also calls
//                `opts.onUpdateReady` if provided (per team-lead
//                resolution: BOTH always fire, never gate one on the
//                other; activate() is idempotent).
//             d. listens for `controllerchange` → reloads the page,
//                guarded against the first-install case (no prior
//                controller existed when the SW registered).
//
//   #27 P2: routes register() rejection through `opts.onSwError` so
//           Sentry/Datadog see the failure (and a console.error
//           fallback covers the no-callback case).
//
// Idle auto-activate (configurable via `idleThresholdMs`):
//   - When a waiting SW is detected, an idle timer starts ticking.
//   - User input events (mousemove, keydown, pointerdown, scroll,
//     touchstart) reset the timer.
//   - Hidden tabs activate immediately — no engaged user.
//   - When the timer fires, activate() runs automatically.
//   - `idleThresholdMs: Infinity` disables idle auto-activate. The
//     update-ready event still fires; the app must call activate()
//     itself.
//
// The bug fixes (updateViaCache: 'none', registration.update() polling,
// deferred skipWaiting, controllerchange reload, dev SW self-unregister,
// onSwError callback) are framework defaults — NOT opt-out. Only the
// idle threshold and observability hooks are configurable.

export type SwUpdateReadyEvent = {
  // Imperatively activate the waiting SW. Sends `crucible:skip-waiting`
  // to the waiting worker, which calls `skipWaiting()` and triggers
  // `controllerchange` → page reload. Idempotent: safe to call when no
  // SW is waiting (no-ops) or when activation is already in flight.
  activate: () => void;
};

export type SwUpdateReadyEventDetail = SwUpdateReadyEvent;

export type SwUpdateOptions = {
  swUrl: string;
  /**
   * Milliseconds of user inactivity before Crucible auto-applies a
   * waiting SW. Default 300_000 (5 min).
   *
   * Set to `Infinity` to disable idle auto-activate entirely. The
   * `crucible:update-ready` window event and `onUpdateReady` callback
   * still fire; the app must call `activate()` itself.
   *
   * NOTE: this is the ONLY opt-out for SW update behavior. The bug
   * fixes (updateViaCache: 'none', polling, deferred skipWaiting,
   * controllerchange reload, etc.) are framework defaults and not
   * configurable.
   */
  idleThresholdMs?: number;
  /**
   * Called when a new SW has installed and is waiting. Always fires in
   * parallel with the `crucible:update-ready` window event — never gated
   * on each other. Calling `event.activate()` is idempotent; the window
   * listener calling activate concurrently is safe.
   */
  onUpdateReady?: (event: SwUpdateReadyEvent) => void;
  /**
   * Called when `navigator.serviceWorker.register()` rejects. Wire to
   * Sentry/Datadog. Defaults to `console.error` if omitted.
   */
  onSwError?: (err: unknown) => void;
};

const DEFAULT_IDLE_THRESHOLD_MS = 300_000;
const UPDATE_POLL_THROTTLE_MS = 60_000;
const UPDATE_READY_EVENT = "crucible:update-ready";
const SKIP_WAITING_MESSAGE = "crucible:skip-waiting";
const INPUT_EVENTS = [
  "mousemove",
  "keydown",
  "pointerdown",
  "scroll",
  "touchstart",
] as const;

// Test seam. Production passes nothing; tests pass a fake clock + scheduler.
export type Clock = {
  now: () => number;
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

// Returns a teardown function. Idempotent — calling teardown twice is
// safe (later calls are no-ops). Safe under StrictMode dev double-invoke
// because the cleanup releases all listeners before the second mount.
export function initSwUpdate(
  opts: SwUpdateOptions,
  // Internal — not in the public type. Tests inject a fake clock.
  _clock: Clock = REAL_CLOCK,
): () => void {
  // Bail if SW isn't supported. The page works without it.
  if (
    typeof navigator === "undefined" ||
    !("serviceWorker" in navigator) ||
    navigator.serviceWorker == null ||
    typeof window === "undefined"
  ) {
    return () => {};
  }

  const idleThresholdMs = opts.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
  const idleAutoActivate = idleThresholdMs !== Infinity;
  // First-install guard: when register() resolves, if there's no
  // existing controller, the *next* `controllerchange` is the SW
  // claiming this page on its initial activation — that should NOT
  // trigger a reload (we'd reload the page on first load, an infinite
  // loop). Only later controllerchanges (i.e. after an explicit
  // skipWaiting) reload.
  const hadControllerAtInit = navigator.serviceWorker.controller != null;
  let firstActivationReloadConsumed = !hadControllerAtInit ? false : true;

  let teardownCalled = false;
  const cleanups: Array<() => void> = [];

  function addListener<K extends keyof WindowEventMap>(
    target: Window,
    event: K,
    handler: (e: WindowEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void;
  function addListener<K extends keyof DocumentEventMap>(
    target: Document,
    event: K,
    handler: (e: DocumentEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void;
  function addListener<K extends keyof ServiceWorkerContainerEventMap>(
    target: ServiceWorkerContainer,
    event: K,
    handler: (e: ServiceWorkerContainerEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void;
  function addListener(
    target: EventTarget,
    event: string,
    handler: EventListener,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(event, handler, options);
    cleanups.push(() => target.removeEventListener(event, handler, options));
  }

  // ---- Idle detection ---------------------------------------------------

  let idleTimer: unknown = null;
  let waitingActivate: (() => void) | null = null;

  function clearIdleTimer(): void {
    if (idleTimer != null) {
      _clock.clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function armIdleTimer(): void {
    if (!idleAutoActivate) return;
    clearIdleTimer();
    idleTimer = _clock.setTimeout(() => {
      idleTimer = null;
      // Re-check at fire time: the waiting SW may have been claimed by
      // another tab while this tab was idle.
      waitingActivate?.();
    }, idleThresholdMs);
  }

  function onUserInput(): void {
    // Only meaningful while a waiting SW is pending; otherwise no timer
    // exists to reset. Cheap to no-op-and-return when nothing's pending.
    if (waitingActivate == null) return;
    armIdleTimer();
  }

  function onVisibilityChange(): void {
    if (waitingActivate == null) return;
    if (document.visibilityState === "hidden") {
      // Hidden tab — no engaged user. Activate immediately.
      waitingActivate();
    } else {
      // Tab became visible — restart the idle countdown.
      armIdleTimer();
    }
  }

  // ---- registration.update() polling ------------------------------------

  // -1 sentinel: ensures the first call is never throttled. After the
  // first poll, lastUpdateAt is set to the current clock and subsequent
  // calls within UPDATE_POLL_THROTTLE_MS are skipped.
  let lastUpdateAt = -1;
  let activeRegistration: ServiceWorkerRegistration | null = null;

  function pollUpdate(): void {
    if (activeRegistration == null) return;
    const now = _clock.now();
    if (lastUpdateAt >= 0 && now - lastUpdateAt < UPDATE_POLL_THROTTLE_MS) return;
    lastUpdateAt = now;
    void activeRegistration.update().catch(() => {
      // update() can reject if the SW server is unreachable; non-fatal.
      // No retry — the next visibility/focus event will try again.
    });
  }

  function onPagePoll(): void {
    if (document.visibilityState === "visible") pollUpdate();
  }

  // ---- updatefound → installing → waiting ------------------------------

  function handleWaitingWorker(waiting: ServiceWorker): void {
    // De-dupe: if we've already armed for this exact worker, skip.
    if (waitingActivate != null) return;

    let activated = false;
    const activate = (): void => {
      if (activated) return;
      activated = true;
      // Send to the worker that's actually waiting RIGHT NOW. Don't
      // capture `waiting` from the closure — registration.waiting may
      // have rotated if multiple updates queued.
      const target = activeRegistration?.waiting ?? waiting;
      try {
        target.postMessage(SKIP_WAITING_MESSAGE);
      } catch {
        // Worker may be in a state that rejects postMessage (rare).
        // Non-fatal; controllerchange still gets us to a reload if the
        // worker activates by other means.
      }
    };

    waitingActivate = activate;

    // Arm idle countdown immediately. Hidden tabs activate now.
    if (document.visibilityState === "hidden" && idleAutoActivate) {
      activate();
    } else {
      armIdleTimer();
    }

    // Always dispatch the window event AND call the prop callback.
    // Resolution from team-lead: don't gate one on the other. activate()
    // is idempotent so calling it from both paths is harmless.
    const detail: SwUpdateReadyEventDetail = { activate };
    try {
      window.dispatchEvent(new CustomEvent(UPDATE_READY_EVENT, { detail }));
    } catch {
      // CustomEvent unavailable in some test runtimes — fall back to
      // ignoring this dispatch path; the prop callback below still fires.
    }
    try {
      opts.onUpdateReady?.({ activate });
    } catch (err) {
      // Don't let a misbehaving callback break the SW pipeline.
      console.error("[crucible] onUpdateReady threw:", err);
    }
  }

  function watchInstallingWorker(installing: ServiceWorker): void {
    const onState = (): void => {
      if (
        installing.state === "installed" &&
        // A worker reaches 'installed' on both first install (where it
        // proceeds straight to activating) and on update (where it
        // becomes 'waiting'). Disambiguate by checking whether the
        // page has an existing controller.
        navigator.serviceWorker.controller != null
      ) {
        installing.removeEventListener("statechange", onState);
        handleWaitingWorker(installing);
      } else if (
        installing.state === "redundant" ||
        installing.state === "activated"
      ) {
        installing.removeEventListener("statechange", onState);
      }
    };
    installing.addEventListener("statechange", onState);
    cleanups.push(() => installing.removeEventListener("statechange", onState));
  }

  function watchRegistration(reg: ServiceWorkerRegistration): void {
    activeRegistration = reg;

    // If there's already a waiting SW at registration time (page loaded
    // mid-update from a prior tab), arm the path immediately.
    if (reg.waiting != null && navigator.serviceWorker.controller != null) {
      handleWaitingWorker(reg.waiting);
    }

    // If there's an installing SW already (race with an in-flight update),
    // hook it.
    if (reg.installing != null) {
      watchInstallingWorker(reg.installing);
    }

    const onUpdateFound = (): void => {
      const installing = reg.installing;
      if (installing != null) watchInstallingWorker(installing);
    };
    reg.addEventListener("updatefound", onUpdateFound);
    cleanups.push(() => reg.removeEventListener("updatefound", onUpdateFound));
  }

  // ---- controllerchange → reload ---------------------------------------

  function onControllerChange(): void {
    if (!firstActivationReloadConsumed) {
      // First activation after a no-controller page load. Don't reload.
      firstActivationReloadConsumed = true;
      return;
    }
    // Page-level reload picks up the new bundle.
    window.location.reload();
  }

  addListener(navigator.serviceWorker, "controllerchange", onControllerChange);

  // ---- Listeners --------------------------------------------------------

  for (const ev of INPUT_EVENTS) {
    addListener(document, ev, onUserInput, { passive: true });
  }
  addListener(document, "visibilitychange", onVisibilityChange);
  addListener(window, "focus", onPagePoll);
  addListener(document, "visibilitychange", onPagePoll);

  // ---- Register ---------------------------------------------------------

  navigator.serviceWorker
    // P0 fix: updateViaCache 'none' bypasses HTTP cache for /sw.js so
    // the browser actually checks for updates instead of serving a
    // potentially-stale cached SW for up to 24h.
    .register(opts.swUrl, { updateViaCache: "none" })
    .then((reg) => {
      if (teardownCalled) return;
      watchRegistration(reg);
    })
    .catch((err: unknown) => {
      if (teardownCalled) return;
      if (opts.onSwError) {
        try {
          opts.onSwError(err);
        } catch (cbErr) {
          console.error("[crucible] onSwError threw:", cbErr);
        }
      } else {
        console.error("[crucible] service worker registration failed:", err);
      }
    });

  return function teardown(): void {
    if (teardownCalled) return;
    teardownCalled = true;
    clearIdleTimer();
    waitingActivate = null;
    activeRegistration = null;
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      try {
        fn?.();
      } catch {
        // Listener removal must not throw out of teardown.
      }
    }
  };
}

// Public-shape constants exported for test pinning. Do NOT re-export
// these from `crucible.ts` — they're internal contract.
export const _internals = {
  UPDATE_READY_EVENT,
  SKIP_WAITING_MESSAGE,
  UPDATE_POLL_THROTTLE_MS,
  DEFAULT_IDLE_THRESHOLD_MS,
  INPUT_EVENTS,
} as const;
