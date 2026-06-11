import { useCallback, useEffect, useRef } from "react";
import { loadQuery, type PreloadedQuery } from "react-relay";
import type { OperationType } from "relay-runtime";
import type { Environment } from "../environment.ts";
import { isRouterTarget } from "../url-safety.ts";
import type { Buckets } from "./buckets.ts";
import type { MatchFn } from "./match.ts";
import {
  PREFETCH_TTL_MS,
  shouldSkipPrefetch,
  warmSubEntrypoint,
  type PrefetchEntry,
} from "./prefetch.ts";

// Prefetch subsystem extracted from `<App>`. Owns the in-flight cache,
// the per-href TTL guard, the chunk-load fan-out, and cleanup on
// unmount. Exposed via `useNavigation`'s `prefetch` callback; the
// matcher is plumbed in so callers can override URL-shape handling.
//
// Why a hook (not a function): the cache is a per-mount Map, and the
// cleanup MUST run on unmount. A bare function would leak queryRefs.

export function usePrefetchCache(
  buckets: Buckets,
  env: Environment["relay"],
  match: MatchFn,
): (to: string) => void {
  const prefetchCache = useRef<Map<string, PrefetchEntry>>(new Map());

  // Cleanup any in-flight prefetches on unmount so we don't retain queryRefs.
  useEffect(() => {
    const cache = prefetchCache.current;
    return () => {
      for (const entry of cache.values()) entry.dispose();
      cache.clear();
    };
  }, []);

  return useCallback(
    (to: string) => {
      if (!isRouterTarget(to)) return;
      if (shouldSkipPrefetch()) return;
      const cache = prefetchCache.current;
      const url = new URL(to, window.location.href);
      const key = url.pathname + url.search;
      if (cache.has(key)) return; // already warm
      const matched = match(buckets.mainRoutes, url.pathname);
      if (!matched) return;

      // Code chunks first — cheap, no network for already-cached modules.
      void matched.route.entrypoint.root.load();
      for (const frame of matched.route.frames) {
        if (frame.layout) void frame.layout.load();
      }

      const preload = {
        params: matched.params,
        search: new URLSearchParams(url.search),
      };
      const { queries } = matched.route.entrypoint.getPreloadProps(preload);
      const refs: PreloadedQuery<never>[] = [];
      for (const query of Object.values(queries)) {
        refs.push(
          loadQuery<OperationType>(env, query.parameters, query.variables, {
            fetchPolicy: "store-and-network",
          }) as PreloadedQuery<never>,
        );
      }
      // Recurse into the page's sub-entrypoints so heavy sidebars/feeds
      // don't suspend cold on click. Mirrors `loadEntrypoint` in load.ts.
      if (matched.route.entrypoint.entryPoints) {
        for (const sub of Object.values(matched.route.entrypoint.entryPoints)) {
          warmSubEntrypoint(env, sub, preload, refs);
        }
      }

      const timer = setTimeout(() => {
        cache.delete(key);
        for (const r of refs) r.dispose();
      }, PREFETCH_TTL_MS);
      cache.set(key, {
        dispose: () => {
          clearTimeout(timer);
          for (const r of refs) r.dispose();
        },
      });
    },
    [buckets.mainRoutes, env, match],
  );
}
