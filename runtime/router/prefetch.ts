import { loadQuery, type PreloadedQuery } from "react-relay";
import type { OperationType } from "relay-runtime";
import type {
  PreloadParams,
  QueryParameter,
  SubEntryPoint,
} from "../entrypoint.ts";
import type { Environment } from "../environment.ts";

// Network Information API hook — narrow declaration, draft web standard.
type NetworkInformation = {
  saveData?: boolean;
  effectiveType?: "slow-2g" | "2g" | "3g" | "4g";
};

// True when we should NOT spend bandwidth on speculative loads — user
// has data-saver on, or the connection is too slow to make the prefetch
// pay off before they navigate.
export function shouldSkipPrefetch(): boolean {
  if (typeof navigator === "undefined") return true;
  const conn = (navigator as unknown as { connection?: NetworkInformation })
    .connection;
  if (conn?.saveData) return true;
  if (conn?.effectiveType === "slow-2g" || conn?.effectiveType === "2g") {
    return true;
  }
  return false;
}

// Per-href prefetch retention. The router holds these in a Map; on
// expiry, the dispose runs — releasing the Relay queryRefs so the store
// can GC them. The CACHED data sticks around either way; only the
// explicit retention is dropped.
export type PrefetchEntry = {
  dispose: () => void;
};

export const PREFETCH_TTL_MS = 30_000;

// Recursively warm a sub-entrypoint: kick off its queries (retained in
// `refs` so the caller can dispose them on TTL or unmount) and start
// loading its module chunk. Mirrors `loadSub` in load.ts but doesn't
// return a `LoadedSubEntrypoint` — prefetching just needs the side
// effects + retained refs.
export function warmSubEntrypoint(
  env: Environment["relay"],
  ep: SubEntryPoint<Record<string, QueryParameter>>,
  preload: PreloadParams,
  refs: PreloadedQuery<never>[],
): void {
  const { queries } = ep.getPreloadProps(preload);
  for (const query of Object.values(queries)) {
    refs.push(
      loadQuery<OperationType>(env, query.parameters, query.variables, {
        fetchPolicy: "store-and-network",
      }) as PreloadedQuery<never>,
    );
  }
  void ep.root.load();
  if (ep.entryPoints) {
    for (const sub of Object.values(ep.entryPoints)) {
      warmSubEntrypoint(env, sub, preload, refs);
    }
  }
}
