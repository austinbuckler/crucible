import { loadQuery, type PreloadedQuery } from "react-relay";
import type { OperationType } from "relay-runtime";
import type { JSResource, PreloadParams, QueryParameter, SubEntryPoint } from "../entrypoint.ts";
import type { Environment } from "../environment.ts";
import type {
  LoadedEntrypoint,
  LoadedSubEntrypoint,
  Location,
  Match,
} from "./types.ts";

// Read a `JSResource`'s cached module synchronously, suspending
// (throwing the load promise) when not yet loaded. This is the React
// Suspense convention — Suspense boundaries catch the thrown promise
// and render the fallback while it settles.
export function readResource<T extends object>(resource: JSResource<T>): T {
  const cached = resource.getModuleIfRequired();
  if (cached) return cached;
  throw resource.load();
}

// Walk a loaded sub-entrypoint and dispose every PreloadedQuery handle.
// Disposing a `PreloadedQuery` releases its retain on the Relay store
// records AND aborts the underlying fetch (via the network handler's
// AbortController bridge in `environment.ts`).
export function disposeLoadedSub(sub: LoadedSubEntrypoint): void {
  for (const ref of Object.values(sub.preloaded)) ref.dispose();
  for (const child of Object.values(sub.entryPoints)) disposeLoadedSub(child);
}

// Disposal for a top-level loaded entrypoint — page queries, plus
// every nested sub-entrypoint's queries. Used when a nav is superseded
// before commit (the resolution it produced will never render, so its
// queries should be released to free network + store records).
export function disposeLoadedEntrypoint(loaded: LoadedEntrypoint): void {
  for (const ref of Object.values(loaded.preloaded)) ref.dispose();
  for (const child of Object.values(loaded.entryPoints)) disposeLoadedSub(child);
}

// Fire `loadQuery` for every preloadable query a sub-entrypoint declares,
// recurse into nested sub-entrypoints, and start loading the chunk.
// Returns a `LoadedSubEntrypoint` whose `preloaded` map is what
// `usePreloadedQuery` will read.
//
// `store-and-network` policy: when the cache has the records, render
// them immediately (no suspense, no flash). Always also kick off a
// network request that updates the store when it returns. This is SWR —
// stale cache shows fast, fresh data arrives in the background and
// components re-render via Relay's reactive subscriptions. When the
// cache is missing, behaves like `store-or-network` and suspends.
export function loadSub(
  env: Environment["relay"],
  ep: SubEntryPoint<Record<string, QueryParameter>>,
  preload: PreloadParams,
): LoadedSubEntrypoint {
  const { queries } = ep.getPreloadProps(preload);
  const preloaded: Record<string, PreloadedQuery<never>> = {};
  for (const [key, query] of Object.entries(queries)) {
    preloaded[key] = loadQuery<OperationType>(
      env,
      query.parameters,
      query.variables,
      {
        fetchPolicy: "store-and-network",
      },
    ) as PreloadedQuery<never>;
  }
  void ep.root.load();
  const entryPoints: Record<string, LoadedSubEntrypoint> = {};
  if (ep.entryPoints) {
    for (const [name, sub] of Object.entries(ep.entryPoints)) {
      entryPoints[name] = loadSub(env, sub, preload);
    }
  }
  return { ep, preloaded, entryPoints };
}

// Fire all preloads (page queries, layout chunks, sub-entrypoints) for a
// matched route. Returns the loaded record the renderer consumes.
//
// CRITICAL: this function is intentionally side-effectful (`loadQuery`
// mutates the Relay store). Callers must invoke it in event-handler or
// useState-initializer context — NOT inside `useMemo` during render.
// React may discard a render mid-flight; a discarded render that fired
// `loadQuery` would orphan the PreloadedQuery's retain handle.
export function loadEntrypoint(
  env: Environment["relay"],
  match: Match,
  location: Location,
): LoadedEntrypoint {
  const preload: PreloadParams = {
    params: match.params,
    search: location.search,
  };
  const { queries } = match.route.entrypoint.getPreloadProps(preload);
  const preloaded: Record<string, PreloadedQuery<never>> = {};
  for (const [key, query] of Object.entries(queries)) {
    preloaded[key] = loadQuery<OperationType>(
      env,
      query.parameters,
      query.variables,
      {
        fetchPolicy: "store-and-network",
      },
    ) as PreloadedQuery<never>;
  }
  void match.route.entrypoint.root.load();
  for (const frame of match.route.frames) {
    if (frame.layout) void frame.layout.load();
  }
  const entryPoints: Record<string, LoadedSubEntrypoint> = {};
  if (match.route.entrypoint.entryPoints) {
    for (const [name, sub] of Object.entries(
      match.route.entrypoint.entryPoints,
    )) {
      entryPoints[name] = loadSub(env, sub, preload);
    }
  }
  return { route: match.route, preloaded, entryPoints };
}
