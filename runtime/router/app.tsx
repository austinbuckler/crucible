import {
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
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
import { withViewTransition } from "./view-transitions.ts";
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
  // Wrap state changes in `document.startViewTransition` when supported.
  // Default `true`. Set `false` if your animations conflict with the
  // browser's transition snapshots.
  viewTransitions?: boolean;
  // Restore scroll position on back/forward, scroll-to-top on push, and
  // scroll-to-hash on hash-bearing URLs. Default `true`.
  restoreScroll?: boolean;
  // Manage focus across navigations (focus the page's main landmark or
  // a `[data-crucible-focus-target]` element). Default `true`.
  manageFocus?: boolean;
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

type RouterState = {
  location: ReturnType<typeof parseLocation>;
  navSource: NavSource;
  resolution: Resolution;
  // `performance.now()` snapshot from when this navigation was initiated.
  // For `init`, this is the App-mount timestamp. Carried so post-commit
  // observers can compute resolve-time deltas.
  startedAt: number;
};

export function App({
  routes,
  environment,
  onError,
  errorFallback = DefaultError,
  viewTransitions = true,
  restoreScroll = true,
  manageFocus = true,
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
  useEffect(() => {
    onNavigateRef.current = onNavigate;
    onResolveRef.current = onResolve;
  });

  // Last successfully-matched `page` route the user navigated to, kept
  // so on soft nav to a URL with no main match we preserve the previous
  // page (Next-style) and intercept renders have a frozen main beneath
  // them. Mutated in `useEffect` after commit only — concurrent renders
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

  // Resolution that `applyNav` produced but hasn't committed yet (the
  // transition is still pending). When a NEW nav fires before this one
  // commits — rapid double-click, or back-button mid-transition — the
  // prior resolution will never render: dispose its PreloadedQuery
  // refs so the orphaned queries release their store retains and abort
  // their in-flight fetches. Cleared in the post-commit effect once
  // its resolution lands as `state.resolution`.
  const pendingResolutionRef = useRef<Resolution | null>(null);
  const committedResolutionRef = useRef<Resolution | null>(null);
  const unmountDisposeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // Initial state: synchronously match + load for the URL we boot at.
  // The useState initializer runs once per mount (twice in StrictMode
  // dev, which is fine — Relay's loadQuery is idempotent for the same
  // op+vars and the discarded mount disposes its component subtree).
  // `useTransition` over bare `startTransition` — same scheduling
  // behavior, plus we surface `isPending` through the navigation
  // context so consumers can render a progress bar / dim outgoing
  // screen during in-flight navigations. (Per the React docs:
  // > startTransition does not provide a way to track whether a
  // > transition is pending. To show a pending indicator while the
  // > transition is ongoing, you need useTransition instead.
  // — react.dev/reference/react/startTransition#caveats)
  const [isPending, startTransition] = useTransition();

  const [state, setState] = useState<RouterState>(() => {
    const startedAt = performance.now();
    const location = parseLocation(new URL(window.location.href));
    const resolution = resolveAndLoad(buckets, location, "init", env, {
      lastMain: null,
      lastSlots: new Map(),
    });
    return {
      location,
      navSource: "init",
      resolution,
      startedAt,
    };
  });

  // Update preservation refs AFTER commit so a discarded render's
  // matches don't poison the "last seen" state.
  useEffect(() => {
    if (state.resolution.mainCommit) {
      lastMainRef.current = state.resolution.mainCommit;
    }
    applySlotCommits(
      lastSlotsRef.current,
      buckets.allSlots,
      state.resolution,
    );
    lastLocationRef.current = state.location;
    const resolvedAt = performance.now();
    onResolveRef.current?.({
      location: {
        pathname: state.location.pathname,
        search: state.location.search.toString(),
        hash: state.location.hash,
      },
      resolution: state.resolution,
      startedAt: state.startedAt,
      resolvedAt,
      durationMs: resolvedAt - state.startedAt,
    });
  }, [state.resolution, state.location, state.startedAt, buckets.allSlots]);

  // Release committed `loadQuery` retains when the rendered resolution is
  // replaced. Do this in effect setup, not cleanup: React StrictMode replays
  // effect cleanup/setup in dev, and cleanup-based disposal would release the
  // still-rendered PreloadedQuery refs during that replay.
  useEffect(() => {
    if (unmountDisposeTimerRef.current) {
      clearTimeout(unmountDisposeTimerRef.current);
      unmountDisposeTimerRef.current = null;
    }
    const previous = committedResolutionRef.current;
    if (previous && previous !== state.resolution) {
      disposeResolution(previous);
    }
    committedResolutionRef.current = state.resolution;
    if (pendingResolutionRef.current === state.resolution) {
      pendingResolutionRef.current = null;
    }
  }, [state.resolution]);

  useEffect(() => {
    return () => {
      // Delay actual unmount disposal by one task so StrictMode's dev-only
      // cleanup/setup replay can cancel it in the setup above.
      unmountDisposeTimerRef.current = setTimeout(() => {
        const committed = committedResolutionRef.current;
        if (committed) disposeResolution(committed);
        if (pendingResolutionRef.current) {
          disposeResolution(pendingResolutionRef.current);
          pendingResolutionRef.current = null;
        }
        committedResolutionRef.current = null;
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
      // Cancel any in-flight nav whose resolution hasn't committed.
      // `disposeResolution` walks every PreloadedQuery handle (main + slots)
      // and calls `.dispose()`. The
      // network handler bridges Relay's unsubscribe into an
      // `AbortController.abort()`, so the underlying fetch (and any
      // pending transient-retry sleep) is cancelled too.
      if (pendingResolutionRef.current) {
        disposeResolution(pendingResolutionRef.current);
        pendingResolutionRef.current = null;
      }
      const resolution = resolveAndLoad(buckets, newLocation, source, env, {
        lastMain: lastMainRef.current,
        lastSlots: lastSlotsRef.current,
      });
      pendingResolutionRef.current = resolution;
      const commit = () => {
        historyOp();
        // Wrap the route swap in `startTransition` so React keeps the
        // outgoing screen on-screen until the new route's queries
        // resolve. Without this, suspending the new page tears the old
        // tree down to the nearest <Suspense> and shows its fallback
        // (DefaultLoading) for the full network round-trip — which is
        // what the user was hitting on every nav. The pre-loaded
        // `PreloadedQuery` refs already kicked off in `resolveAndLoad`,
        // so the transition simply parks the commit until those
        // resolve, then atomically swaps to the new tree.
        startTransition(() => {
          setState({
            location: newLocation,
            navSource: source,
            resolution,
            startedAt,
          });
        });
      };
      withViewTransition(commit, viewTransitions);
    },
    [buckets, env, viewTransitions],
  );

  // Stable matcher reference for prefetch — caller can override.
  const match = matcher ?? matchRoute;

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

  return (
    <PlatformProvider value={environment.platform}>
      <RelayEnvironmentProvider environment={environment.relay}>
        <NavigationContext value={navContext}>
          <ErrorBoundary
            FallbackComponent={errorFallback}
            onError={handleError}
          >
            <NotFoundBoundary fallback={<DefaultNotFound />}>
              <Suspense fallback={<DefaultLoading />}>
                <RouteOutlet
                  resolution={state.resolution}
                  rawSearch={state.location.search}
                  onError={handleError}
                />
              </Suspense>
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
