import {
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import * as React from "react";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";
import { RelayEnvironmentProvider } from "react-relay";
import type { Environment } from "../environment.ts";
import { NotFoundBoundary } from "../not-found.tsx";
import { PlatformProvider } from "../platform.ts";
import { assertRouterTarget } from "../url-safety.ts";
import { WindowsHost } from "../window.tsx";
import { bucketRoutes } from "./buckets.ts";
import {
  NavigationContext,
  parseLocation,
} from "./context.ts";
import {
  DefaultError,
  DefaultLoading,
  DefaultNotFound,
} from "./defaults.tsx";
import { defaultFocusBehavior, type FocusBehavior } from "./focus.ts";
import { matchRoute, type MatchFn } from "./match.ts";
import { applySlotCommits } from "./preserve.ts";
import {
  disposeResolution,
  resolveAndLoad,
  type Resolution,
} from "./resolve.ts";
import {
  defaultScrollBehavior,
  SCROLL_KEY,
  type ScrollBehavior,
} from "./scroll.ts";
import type { Match, NavSource, RouteRecord } from "./types.ts";
import { useBrowserNavListeners } from "./use-browser-nav-listeners.ts";
import { usePrefetchCache } from "./use-prefetch-cache.ts";
import {
  useFocusManagement,
  useScrollRestoration,
} from "./use-scroll-and-focus.ts";
import { RouteOutlet } from "./outlet.tsx";

export type AppProps = {
  routes: ReadonlyArray<RouteRecord>;
  environment: Environment;
  // Called when a frame's error boundary catches an exception. Wire to
  // Sentry/Datadog/etc. The handler runs at every level — top-level App
  // boundary AND per-frame `error.tsx` boundaries — so a single
  // subscription captures every router-rendered error.
  onError?: (error: unknown, info: ErrorInfo) => void;
  // Fallback rendered by the top-level error boundary. Defaults to a
  // built-in. Per-frame `error.tsx` files take precedence when present.
  errorFallback?: ComponentType<FallbackProps>;
  // Enable React's canary `<ViewTransition>` wrapper when the installed
  // React runtime exports it. Defaults to the Vite plugin's
  // `experimental.reactViewTransitions` flag. Crucible never calls the
  // native `document.startViewTransition` API directly.
  viewTransitions?: boolean;
  // Restore scroll position on back/forward, scroll-to-top on push, and
  // scroll-to-hash on hash-bearing URLs. Default `true`.
  restoreScroll?: boolean;
  // Manage focus across navigations (focus the page's main landmark or
  // a `[data-crucible-focus-target]` element). Default `true`.
  manageFocus?: boolean;
  // Fallback rendered while the initial route is being resolved. Defaults to
  // the built-in loading fallback. Generated apps with their own splash can
  // pass `null` once they intentionally own boot UI.
  bootFallback?: ReactNode;
  // Pluggable matcher. Default uses `matchRoute`. Replace for advanced
  // URL-shape handling (locale prefixes, case-insensitive, etc.).
  matcher?: MatchFn;
  // Pluggable scroll strategy. Default = `defaultScrollBehavior`.
  scrollBehavior?: ScrollBehavior;
  // Pluggable focus strategy. Default = `defaultFocusBehavior`.
  focusBehavior?: FocusBehavior;
  // Observability hook fired on every navigation, before resolve.
  // `startedAt` is `performance.now()` at the moment `navigate()` /
  // popstate fired; pair with `onResolve.startedAt` to compute end-to-end
  // navigation latency.
  onNavigate?: (event: {
    from: { pathname: string; search: string; hash: string };
    to: { pathname: string; search: string; hash: string };
    source: NavSource;
    startedAt: number;
  }) => void;
  // Observability hook fired after every resolution, with the matched
  // route and the loaded entrypoint. Useful for analytics page-view
  // tracking and performance hooks. `startedAt` is the same value
  // emitted by `onNavigate` for the matching navigation; `resolvedAt` is
  // the `performance.now()` snapshot at commit time; `durationMs =
  // resolvedAt - startedAt`. For `init` (boot), `startedAt` is the
  // App-mount timestamp.
  onResolve?: (event: {
    location: { pathname: string; search: string; hash: string };
    resolution: Resolution;
    startedAt: number;
    resolvedAt: number;
    durationMs: number;
  }) => void;
};

const DEFAULT_REACT_VIEW_TRANSITIONS =
  import.meta.env.CRUCIBLE_REACT_VIEW_TRANSITIONS === true;

type ReactViewTransitionComponent = ComponentType<{
  children?: ReactNode;
  default?: "auto" | "none" | (string & {});
}>;

const ReactViewTransition = (React as typeof React & {
  ViewTransition?: ReactViewTransitionComponent;
}).ViewTransition;

type BootingRouterState = {
  status: "booting";
  location: ReturnType<typeof parseLocation>;
  navSource: "init";
  // `performance.now()` snapshot from when this navigation was initiated.
  startedAt: number;
};

type ReadyRouterState = {
  status: "ready";
  attemptId: number;
  location: ReturnType<typeof parseLocation>;
  navSource: NavSource;
  resolution: Resolution;
  // `performance.now()` snapshot from when this navigation was initiated.
  // For `init`, this is the App-mount timestamp. Carried so post-commit
  // observers can compute resolve-time deltas.
  startedAt: number;
};

type RouterState = BootingRouterState | ReadyRouterState;

// Internal owner-state helpers. Exported so router lifecycle tests can pin
// disposal behavior directly; not part of the public Crucible API.
export type ResolutionOwnerState =
  | "pending"
  | "committed"
  | "abandoned"
  | "disposed";

export type ResolutionOwner = {
  id: number;
  location: ReturnType<typeof parseLocation>;
  navSource: NavSource;
  startedAt: number;
  resolution: Resolution;
  state: ResolutionOwnerState;
  committedAcked: boolean;
  resolveNotified: boolean;
};

export type RouterOwners = {
  nextId: number;
  pending: Map<number, ResolutionOwner>;
  abandoned: Map<number, ResolutionOwner>;
  committed: ResolutionOwner | null;
};

type DisposeResolution = (resolution: Resolution) => void;

export function createRouterOwners(): RouterOwners {
  return {
    nextId: 1,
    pending: new Map(),
    abandoned: new Map(),
    committed: null,
  };
}

export function addResolutionOwner(
  owners: RouterOwners,
  input: {
    location: ReturnType<typeof parseLocation>;
    navSource: NavSource;
    startedAt: number;
    resolution: Resolution;
  },
): ResolutionOwner {
  const owner: ResolutionOwner = {
    id: owners.nextId++,
    location: input.location,
    navSource: input.navSource,
    startedAt: input.startedAt,
    resolution: input.resolution,
    state: "pending",
    committedAcked: false,
    resolveNotified: false,
  };
  owners.pending.set(owner.id, owner);
  return owner;
}

export function abandonPendingResolutionOwners(owners: RouterOwners): void {
  for (const [id, owner] of owners.pending) {
    owner.state = "abandoned";
    owners.abandoned.set(id, owner);
  }
  owners.pending.clear();
}

export function acknowledgeResolutionOwner(
  owners: RouterOwners,
  attemptId: number,
  dispose: DisposeResolution = disposeResolution,
): { owner: ResolutionOwner; firstCommitAck: boolean } | null {
  const owner =
    owners.committed?.id === attemptId
      ? owners.committed
      : owners.pending.get(attemptId);
  if (!owner || owner.state === "disposed") return null;

  const firstCommitAck = !owner.committedAcked;
  const wasPending = owner.state === "pending";
  const previous = owners.committed;
  if (previous && previous.id !== owner.id) {
    disposeResolutionOwner(previous, dispose);
  }

  owners.pending.delete(owner.id);
  owners.abandoned.delete(owner.id);
  owners.committed = owner;
  owner.state = "committed";
  owner.committedAcked = true;

  if (wasPending) {
    for (const [id, abandoned] of owners.abandoned) {
      owners.abandoned.delete(id);
      disposeResolutionOwner(abandoned, dispose);
    }
  }

  return { owner, firstCommitAck };
}

export function disposeAllResolutionOwners(
  owners: RouterOwners,
  dispose: DisposeResolution = disposeResolution,
): void {
  const seen = new Set<number>();
  const disposeOnce = (owner: ResolutionOwner | null) => {
    if (!owner || seen.has(owner.id)) return;
    seen.add(owner.id);
    disposeResolutionOwner(owner, dispose);
  };

  disposeOnce(owners.committed);
  for (const owner of owners.pending.values()) disposeOnce(owner);
  for (const owner of owners.abandoned.values()) disposeOnce(owner);
  owners.committed = null;
  owners.pending.clear();
  owners.abandoned.clear();
}

function disposeResolutionOwner(
  owner: ResolutionOwner,
  dispose: DisposeResolution,
): void {
  if (owner.state === "disposed") return;
  owner.state = "disposed";
  dispose(owner.resolution);
}

function hasResolutionOwners(owners: RouterOwners): boolean {
  return owners.committed != null ||
    owners.pending.size > 0 ||
    owners.abandoned.size > 0;
}

function getResolutionOwner(
  owners: RouterOwners,
  attemptId: number,
): ResolutionOwner | null {
  if (owners.committed?.id === attemptId) return owners.committed;
  return owners.pending.get(attemptId) ?? owners.abandoned.get(attemptId) ?? null;
}

export function canRenderResolutionOwner(
  owners: RouterOwners,
  attemptId: number,
): boolean {
  const owner = getResolutionOwner(owners, attemptId);
  return !!owner && owner.state === "committed";
}

export function canStartResolutionOwnerCommit(
  owners: RouterOwners,
  attemptId: number,
): boolean {
  return owners.pending.get(attemptId)?.state === "pending";
}

export function App({
  routes,
  environment,
  onError,
  errorFallback = DefaultError,
  viewTransitions = DEFAULT_REACT_VIEW_TRANSITIONS,
  restoreScroll = true,
  manageFocus = true,
  bootFallback = <DefaultLoading />,
  matcher,
  scrollBehavior = defaultScrollBehavior,
  focusBehavior = defaultFocusBehavior,
  onNavigate,
  onResolve,
}: AppProps) {
  const buckets = useMemo(() => bucketRoutes(routes), [routes]);
  const env = environment.relay;

  // Keep observability hooks in refs so changing them doesn't invalidate
  // the navigate / popstate callbacks.
  const onNavigateRef = useRef(onNavigate);
  const onResolveRef = useRef(onResolve);
  useLayoutEffect(() => {
    onNavigateRef.current = onNavigate;
    onResolveRef.current = onResolve;
  });

  // Last successfully-matched `page` route the user navigated to, kept
  // so on soft nav to a URL with no main match we preserve the previous
  // page (Next-style) and intercept renders have a frozen main beneath
  // them. Mutated after commit acknowledgment only — concurrent renders
  // can be discarded; we don't want refs that point at routes the user
  // never actually saw.
  const lastMainRef = useRef<Match | null>(null);
  const lastSlotsRef = useRef<Map<string, Match>>(new Map());

  // Snapshot of the currently-rendered location, mirrored into a ref so
  // event-driven callbacks (popstate handler) can read the URL we're
  // LEAVING from without invalidating their identity per navigation.
  // For popstate, `window.location` has already moved by the time our
  // handler fires — we need this ref to recover the `from` URL.
  const lastLocationRef = useRef<ReturnType<typeof parseLocation> | null>(null);

  const ownersRef = useRef<RouterOwners | null>(null);
  if (ownersRef.current == null) {
    ownersRef.current = createRouterOwners();
  }
  const bootOwnerRef = useRef<ResolutionOwner | null>(null);
  const unmountDisposeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // Initial state starts inert; the layout effect below performs the first
  // side-effectful resolve/load after commit. This avoids render-time
  // `loadQuery` leaks under React StrictMode's dev-only double invocation.
  // `useTransition` over bare `startTransition` — same scheduling
  // behavior, plus we surface `isPending` through the navigation
  // context so consumers can render a progress bar / dim outgoing
  // screen during in-flight navigations. (Per the React docs:
  // > startTransition does not provide a way to track whether a
  // > transition is pending. To show a pending indicator while the
  // > transition is ongoing, you need useTransition instead.
  // — react.dev/reference/react/startTransition#caveats)
  const [isPending, startTransition] = useTransition();
  const match = matcher ?? matchRoute;

  const [state, setState] = useState<RouterState>(() => {
    const startedAt = performance.now();
    const location = parseLocation(new URL(window.location.href));
    return {
      status: "booting",
      location,
      navSource: "init",
      startedAt,
    };
  });

  useLayoutEffect(() => {
    let owner = bootOwnerRef.current;
    if (owner == null) {
      if (hasResolutionOwners(ownersRef.current!)) return;
      const startedAt = state.startedAt;
      const location = state.location;
      const resolution = resolveAndLoad(buckets, location, "init", env, {
        lastMain: null,
        lastSlots: new Map(),
      }, match);
      owner = addResolutionOwner(ownersRef.current!, {
        location,
        navSource: "init",
        startedAt,
        resolution,
      });
      bootOwnerRef.current = owner;
    }
    setState({
      status: "ready",
      attemptId: owner.id,
      location: owner.location,
      navSource: owner.navSource,
      resolution: owner.resolution,
      startedAt: owner.startedAt,
    });
  }, []);

  // Acknowledge rendered attempts in layout-effect setup. Cleanup owns
  // nothing: StrictMode replays cleanup/setup in dev, and disposing there
  // would release query refs that are still rendered.
  useLayoutEffect(() => {
    if (state.status !== "ready") return;
    if (unmountDisposeTimerRef.current) {
      clearTimeout(unmountDisposeTimerRef.current);
      unmountDisposeTimerRef.current = null;
    }

    const acknowledged = acknowledgeResolutionOwner(
      ownersRef.current!,
      state.attemptId,
    );
    if (!acknowledged?.firstCommitAck) return;

    const { owner } = acknowledged;
    const { resolution } = owner;
    if (resolution.mainCommit) {
      lastMainRef.current = resolution.mainCommit;
    }
    applySlotCommits(
      lastSlotsRef.current,
      buckets.allSlots,
      resolution,
    );
    lastLocationRef.current = owner.location;
  }, [state, buckets.allSlots]);

  useEffect(() => {
    if (state.status !== "ready") return;
    const owner = getResolutionOwner(ownersRef.current!, state.attemptId);
    if (!owner?.committedAcked || owner.resolveNotified) return;
    owner.resolveNotified = true;
    const resolvedAt = performance.now();
    onResolveRef.current?.({
      location: {
        pathname: owner.location.pathname,
        search: owner.location.search.toString(),
        hash: owner.location.hash,
      },
      resolution: owner.resolution,
      startedAt: owner.startedAt,
      resolvedAt,
      durationMs: resolvedAt - owner.startedAt,
    });
  }, [state]);

  useEffect(() => {
    if (unmountDisposeTimerRef.current) {
      clearTimeout(unmountDisposeTimerRef.current);
      unmountDisposeTimerRef.current = null;
    }
    return () => {
      // Delay actual unmount disposal by one task so StrictMode's dev-only
      // cleanup/setup replay can cancel it in the setup above.
      unmountDisposeTimerRef.current = setTimeout(() => {
        disposeAllResolutionOwners(ownersRef.current!);
        unmountDisposeTimerRef.current = null;
      }, 0);
    };
  }, []);

  // ---- navigate / popstate / prefetch -----------------------------------

  const applyNav = useCallback(
    (next: URL, source: "soft" | "pop", historyOp: () => void) => {
      const startedAt = performance.now();
      const newLocation = parseLocation(next);
      const fromLocation = pickFromLocation(
        source,
        lastLocationRef.current,
        () => parseLocation(new URL(window.location.href)),
      );
      onNavigateRef.current?.({
        from: {
          pathname: fromLocation.pathname,
          search: fromLocation.search.toString(),
          hash: fromLocation.hash,
        },
        to: {
          pathname: newLocation.pathname,
          search: newLocation.search.toString(),
          hash: newLocation.hash,
        },
        source,
        startedAt,
      });
      // Move uncommitted attempts aside instead of disposing immediately.
      // React may still commit an older transition; disposal happens only
      // after a rendered attempt is acknowledged or when App unmounts.
      abandonPendingResolutionOwners(ownersRef.current!);
      const resolution = resolveAndLoad(buckets, newLocation, source, env, {
        lastMain: lastMainRef.current,
        lastSlots: lastSlotsRef.current,
      }, match);
      const owner = addResolutionOwner(ownersRef.current!, {
        location: newLocation,
        navSource: source,
        startedAt,
        resolution,
      });
      if (!canStartResolutionOwnerCommit(ownersRef.current!, owner.id)) return;
      historyOp();
      // Wrap the route swap in `startTransition` so React keeps the
      // outgoing screen on-screen until the new route's queries resolve.
      // Without this, suspending the new page tears the old tree down to
      // the nearest <Suspense> and shows its fallback (DefaultLoading) for
      // the full network round-trip. The pre-loaded `PreloadedQuery` refs
      // already kicked off in `resolveAndLoad`, so the transition simply
      // parks the commit until those resolve, then atomically swaps to the
      // new tree.
      startTransition(() => {
        setState((current) => {
          if (!canStartResolutionOwnerCommit(ownersRef.current!, owner.id)) {
            return current;
          }
          return {
            status: "ready",
            attemptId: owner.id,
            location: newLocation,
            navSource: source,
            resolution,
            startedAt,
          };
        });
      });
    },
    [buckets, env, match],
  );

  // Stable matcher reference for prefetch — caller can override.
  const navigate = useCallback(
    (to: string, options?: { replace?: boolean }) => {
      assertRouterTarget(to);
      const next = new URL(to, window.location.href);
      // Save current scroll BEFORE pushing — so back-nav can restore it
      // when we land here later. The fresh entry gets scrollY=0 so a
      // forward-nav scrolls to top by default (overridden by hash, below).
      if (restoreScroll) scrollBehavior.save();
      const replace = options?.replace === true;
      applyNav(next, "soft", () => {
        // `replace: true` swaps the current entry instead of pushing a
        // new one. Used for in-place URL refinements (wizard step
        // changes, filter tweaks, dialog mode picks) — anything where
        // back-button should skip past the intermediate state. Mirrors
        // Next.js's `router.replace` and the same option on the History
        // API itself.
        if (replace) {
          window.history.replaceState({ [SCROLL_KEY]: 0 }, "", next);
        } else {
          window.history.pushState({ [SCROLL_KEY]: 0 }, "", next);
        }
      });
    },
    [applyNav, restoreScroll, scrollBehavior],
  );

  useBrowserNavListeners(applyNav);

  const refresh = useCallback(() => {
    // Re-resolve + re-fetch the current URL with no history change.
    // Used by error fallbacks (after `resetErrorBoundary()`) and by
    // consumer code that wants to force a refetch (e.g. after an
    // out-of-band mutation that invalidated the page's queries).
    applyNav(new URL(window.location.href), "soft", () => {});
  }, [applyNav]);

  const prefetch = usePrefetchCache(buckets, env, match);

  useScrollRestoration(
    state.location,
    state.navSource,
    restoreScroll,
    scrollBehavior,
  );

  useFocusManagement(
    state.location.pathname,
    state.navSource,
    manageFocus,
    focusBehavior,
  );

  // ---- Render -----------------------------------------------------------

  const navContext = useMemo(
    () => ({
      location: state.location,
      navigate,
      prefetch,
      refresh,
      isNavigating: isPending,
    }),
    [state.location, navigate, prefetch, refresh, isPending],
  );

  const handleError = useCallback(
    (error: unknown, info: ErrorInfo) => {
      onError?.(error, info);
    },
    [onError],
  );

  const routeContent = state.status === "booting" ? (
    bootFallback
  ) : (
    <Suspense fallback={<DefaultLoading />}>
      <RouteOutlet
        resolution={state.resolution}
        rawSearch={state.location.search}
        onError={handleError}
      />
    </Suspense>
  );
  const transitionContent = viewTransitions && ReactViewTransition ? (
    <ReactViewTransition default="auto">
      {routeContent}
    </ReactViewTransition>
  ) : routeContent;

  return (
    <PlatformProvider value={environment.platform}>
      <RelayEnvironmentProvider environment={environment.relay}>
        <NavigationContext value={navContext}>
          <ErrorBoundary
            FallbackComponent={errorFallback}
            onError={handleError}
          >
            <NotFoundBoundary fallback={<DefaultNotFound />}>
              {transitionContent}
              {/* Mount once at App-level so imperative `openAppWindow(<X/>)`
                  portals join the same React tree (Relay env, platform,
                  navigation, all flow through). */}
              <WindowsHost />
            </NotFoundBoundary>
          </ErrorBoundary>
        </NavigationContext>
      </RelayEnvironmentProvider>
    </PlatformProvider>
  );
}

// Suppress an unused-import warning under strict noUnusedLocals when this
// file is type-checked in isolation. ReactNode is referenced via the
// FallbackProps type signature chain.
void (null as unknown as ReactNode);

// Choose the `from` location to emit on `onNavigate`. For `init`/`soft`,
// `window.location` still reflects the outgoing URL (history hasn't been
// touched yet). For `pop`, the browser has already moved history before
// our handler fires — `window.location` matches `to`, not `from`. We
// recover the outgoing URL from the committed-state mirror.
//
// The function is pure (takes the source string + the ref's current value
// + a `readWindow` thunk) so it's unit-testable without mounting React.
//
// Exported for tests; not part of the public surface.
export function pickFromLocation(
  source: "init" | "soft" | "pop",
  lastLocation: ReturnType<typeof parseLocation> | null,
  readWindow: () => ReturnType<typeof parseLocation>,
): ReturnType<typeof parseLocation> {
  if (source === "pop" && lastLocation) return lastLocation;
  return readWindow();
}
