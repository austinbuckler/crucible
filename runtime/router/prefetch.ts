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
