import { useCallback, useEffect, useRef } from "react";
import { loadQuery, type PreloadedQuery } from "react-relay";
import type { OperationType } from "relay-runtime";
import type { Environment } from "../environment.ts";
import { isRouterTarget } from "../url-safety.ts";
import type { Buckets } from "./buckets.ts";
import { matchDefault, type MatchFn } from "./match.ts";
import type { Match } from "./types.ts";
import {
  PREFETCH_TTL_MS,
  shouldSkipPrefetch,
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
      const matches = collectPrefetchMatches(buckets, url.pathname, match);
      if (matches.length === 0) return;

      const refs: PreloadedQuery<never>[] = [];
      for (const matched of matches) {
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
        for (const query of Object.values(queries)) {
          refs.push(
            loadQuery<OperationType>(env, query.parameters, query.variables, {
              fetchPolicy: "store-and-network",
            }) as PreloadedQuery<never>,
          );
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
    [buckets, env, match],
  );
}

export function collectPrefetchMatches(
  buckets: Buckets,
  pathname: string,
  match: MatchFn,
): ReadonlyArray<Match> {
  const out: Match[] = [];
  const seen = new Set<object>();
  const add = (m: Match | null) => {
    if (!m || seen.has(m.route)) return;
    seen.add(m.route);
    out.push(m);
  };

  const main = match(buckets.mainRoutes, pathname);
  add(main ?? matchDefault(buckets.mainDefaults, pathname));

  for (const slotName of buckets.allSlots) {
    const intercept = match(buckets.slotIntercepts.get(slotName) ?? [], pathname);
    const regular = match(buckets.slotRegulars.get(slotName) ?? [], pathname);
    add(intercept);
    add(regular);
    if (!intercept && !regular) {
      add(matchDefault(buckets.slotDefaults.get(slotName) ?? [], pathname));
    }
  }

  return out;
}
