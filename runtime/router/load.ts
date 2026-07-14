import { loadQuery, type PreloadedQuery } from "react-relay";
import type { OperationType } from "relay-runtime";
import type { JSResource, PreloadParams } from "../entrypoint.ts";
import type { Environment } from "../environment.ts";
import type {
  LoadedEntrypoint,
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

// Disposal for a loaded entrypoint. Used when a nav is superseded before
// commit or a committed resolution is replaced.
export function disposeLoadedEntrypoint(loaded: LoadedEntrypoint): void {
  for (const ref of Object.values(loaded.preloaded)) ref.dispose();
}

// Fire all preloads (page queries and layout chunks) for a matched route.
// Returns the loaded record the renderer consumes.
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
  return { route: match.route, preloaded };
}
