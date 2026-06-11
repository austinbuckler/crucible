import { createContext, use, useDeferredValue, useMemo } from "react";
import {
  selectedChildSegment,
  selectedSlotSegment,
} from "./segment.ts";
import type { Location, Match } from "./types.ts";

export type NavigationContextValue = {
  location: Location;
  // `replace: true` swaps the current history entry instead of pushing
  // a new one — for in-place URL refinements where back-button should
  // skip past the intermediate state (wizard step picker, dialog mode
  // selector, filter tweaks). Mirrors Next.js's `router.replace`.
  navigate: (to: string, options?: { replace?: boolean }) => void;
  // Warm a route's code chunk + queries without navigating. Idempotent
  // per-href: subsequent calls in the TTL window are no-ops.
  prefetch: (to: string) => void;
  // Re-resolve + re-fetch the current URL without changing history.
  // Drives the "Try again" button in the default error fallback and is
  // the recommended retry mechanism for `error.tsx`-supplied fallbacks
  // — call `refresh()` after `resetErrorBoundary()` so the failed
  // queries actually re-fire.
  refresh: () => void;
  // True while a navigation is in flight — set by `useTransition` in
  // `<App>`'s applyNav. Consumers wire this to a top progress bar,
  // dimmed-outgoing-screen, or other "transition pending" UI. Stays
  // false when the destination's queries were already cached and the
  // commit happens synchronously.
  isNavigating: boolean;
};

export const NavigationContext = createContext<NavigationContextValue | null>(
  null,
);

export function useLocation(): Location {
  const ctx = use(NavigationContext);
  if (!ctx) throw new Error("useLocation outside <Crucible.App>");
  return ctx.location;
}

export function useNavigate() {
  const ctx = use(NavigationContext);
  if (!ctx) throw new Error("useNavigate outside <Crucible.App>");
  return ctx.navigate;
}

export function usePrefetch() {
  const ctx = use(NavigationContext);
  if (!ctx) throw new Error("usePrefetch outside <Crucible.App>");
  return ctx.prefetch;
}

/**
 * Re-resolve + re-fetch the current URL, without changing history.
 * Mirror of Next.js's `router.refresh()`. Pair with
 * `resetErrorBoundary()` from a `react-error-boundary` fallback to
 * implement a working "Try again" button:
 *
 *   const refresh = useRefresh();
 *   <button onClick={() => { resetErrorBoundary(); refresh(); }} />
 */
export function useRefresh() {
  const ctx = use(NavigationContext);
  if (!ctx) throw new Error("useRefresh outside <Crucible.App>");
  return ctx.refresh;
}

/**
 * `true` while a navigation is in flight (queries suspending,
 * page chunks loading). Drive a top progress bar, a dimmed outgoing
 * screen, or a cursor-busy indicator off this. Returns `false`
 * when a navigation completed synchronously — i.e. the destination's
 * queries were already in Relay's store.
 */
export function useIsNavigating(): boolean {
  const ctx = use(NavigationContext);
  if (!ctx) throw new Error("useIsNavigating outside <Crucible.App>");
  return ctx.isNavigating;
}

export const ParamsContext = createContext<Record<string, string>>({});

export function useParams<T extends Record<string, string>>(): T {
  return use(ParamsContext) as T;
}

export function useSearchParams(): URLSearchParams {
  return useLocation().search;
}

/**
 * Deferred-value variant of `useSearchParams`. When a navigation
 * changes the URL search string, React keeps returning the **previous**
 * URLSearchParams snapshot until the new render commits. Use this to
 * hold the outgoing UI on-screen during a tab/filter switch — e.g.
 * conditionally-mounted siblings like `view === "unread"` and
 * `view === "all"` keep showing the old branch until the new branch's
 * queries resolve, instead of unmounting + showing the inner Suspense
 * fallback.
 *
 * Per the React docs (`useDeferredValue`), the deferred value must be
 * a primitive or a memoized object so React can compare references —
 * we wrap the URLSearchParams in `useMemo` keyed by its serialized
 * form so two reads of the same query string return the same instance.
 *
 * Pair with the standard React pattern:
 *   const params = Crucible.useDeferredSearchParams();
 *   const view = params.get("view") ?? "all";
 *
 * Or, when you only need a single key, just defer that one:
 *   const view = useDeferredValue(useSearchParams().get("view") ?? "all");
 */
export function useDeferredSearchParams(): URLSearchParams {
  const live = useSearchParams();
  // Memoize on the serialized form so reads of the same params share
  // identity — `useDeferredValue` compares by reference and would
  // never settle on a fresh URLSearchParams instance per render.
  const serialized = live.toString();
  const memo = useMemo(() => new URLSearchParams(serialized), [serialized]);
  return useDeferredValue(memo);
}

// Snapshot of the matches the App resolved for the current location,
// plus the URL depth of the calling layout's directory. Each layout
// pushes a new context value with its own `urlDepth`; descendants reading
// the context see the closest layout's depth, which is what
// `useSelectedLayoutSegment` needs to resolve "the segment immediately
// below this layout's URL position".
//
// `mainMatch` is the match whose `segments` form the active main URL
// path. For top-level reads it's the `<App>`'s main match; inside a
// slot's render tree it's the slot's match (the slot has its own page
// chain, so "children" inside a slot's layout means the slot's segments).
//
// `slotMatches` is keyed by slot name. It's only populated in the
// top-level context — slot subtrees can't have nested slots in v1, so
// nothing reads it from inside a slot.
export type LayoutSegmentContextValue = {
  mainMatch: Match | null;
  slotMatches: ReadonlyMap<string, Match | null>;
  urlDepth: number;
};

export const LayoutSegmentContext =
  createContext<LayoutSegmentContextValue | null>(null);

// `useSelectedLayoutSegment(parallelRouteKey?)` — Crucible's equivalent
// of Next.js's hook of the same name. Mirrors the upstream semantics:
//
//   - With NO arg: returns the URL segment immediately below the calling
//     layout's URL position, or `null` if no descendant page is active.
//   - With a slot arg: returns the deepest segment of the named parallel
//     slot's active route, or `null` if the slot has no active page.
//
// Reference: node_modules/.bun/next@16.1.1+.../next/dist/client/components/
//   navigation.js:176-190 (`useSelectedLayoutSegment`) and
//   node_modules/.bun/next@16.1.1+.../next/dist/shared/lib/segment.js:69-78
//   (`computeSelectedLayoutSegment`).
//
// Returns `null` when called outside `<Crucible.App>` — this matches
// Next.js's behavior in the `pages` router (the upstream source returns
// `null` when its `LayoutRouterContext` is missing) and lets the hook be
// called from components that may be unmounted from the router tree.
export function useSelectedLayoutSegment(
  parallelRouteKey?: string,
): string | null {
  const ctx = use(LayoutSegmentContext);
  if (!ctx) return null;
  if (parallelRouteKey === undefined || parallelRouteKey === "children") {
    return selectedChildSegment(ctx.mainMatch, ctx.urlDepth);
  }
  return selectedSlotSegment(ctx.slotMatches.get(parallelRouteKey) ?? null);
}

export function parseLocation(url: URL): Location {
  return {
    pathname: url.pathname,
    search: new URLSearchParams(url.search),
    hash: url.hash,
  };
}
