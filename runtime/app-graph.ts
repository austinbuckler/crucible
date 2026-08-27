import { useCallback } from "react";

export type LiveState<T> = {
  read: () => T;
  subscribe: (callback: () => void) => () => void;
};

export type AppStorageSnapshot = {
  persisted: boolean | null;
  usage: number | null;
  quota: number | null;
  usageRatio: number | null;
};

const UNKNOWN_STORAGE: AppStorageSnapshot = {
  persisted: null,
  usage: null,
  quota: null,
  usageRatio: null,
};

let storageSnapshot: AppStorageSnapshot = UNKNOWN_STORAGE;
const storageListeners = new Set<() => void>();

export function getStorageSnapshot(): AppStorageSnapshot {
  return storageSnapshot;
}

export function subscribeStorageSnapshot(callback: () => void): () => void {
  storageListeners.add(callback);
  return () => storageListeners.delete(callback);
}

export async function refreshStorageSnapshot(): Promise<AppStorageSnapshot> {
  const storage = globalThis.navigator?.storage;
  if (!storage) {
    setStorageSnapshot(UNKNOWN_STORAGE);
    return storageSnapshot;
  }

  const [persisted, estimate] = await Promise.all([
    typeof storage.persisted === "function"
      ? storage.persisted().catch(() => null)
      : Promise.resolve(null),
    typeof storage.estimate === "function"
      ? storage.estimate().catch(() => null)
      : Promise.resolve(null),
  ]);
  const usage = finiteOrNull(estimate?.usage);
  const quota = finiteOrNull(estimate?.quota);
  setStorageSnapshot({
    persisted,
    usage,
    quota,
    usageRatio: usage != null && quota != null && quota > 0
      ? usage / quota
      : null,
  });
  return storageSnapshot;
}

export async function requestStoragePersistence(): Promise<boolean> {
  const storage = globalThis.navigator?.storage;
  const granted = typeof storage?.persist === "function"
    ? await storage.persist().catch(() => false)
    : false;
  await refreshStorageSnapshot();
  return granted;
}

export function useStorageRefresh(): () => Promise<AppStorageSnapshot> {
  return useCallback(() => refreshStorageSnapshot(), []);
}

export function usePersistenceRequest(): () => Promise<boolean> {
  return useCallback(() => requestStoragePersistence(), []);
}

export function storageLiveState<K extends keyof AppStorageSnapshot>(
  key: K,
): LiveState<AppStorageSnapshot[K]> {
  return {
    read: () => storageSnapshot[key],
    subscribe: subscribeStorageSnapshot,
  };
}

function setStorageSnapshot(next: AppStorageSnapshot): void {
  if (storageSnapshotsEqual(storageSnapshot, next)) return;
  storageSnapshot = next;
  for (const listener of storageListeners) listener();
}

function storageSnapshotsEqual(
  a: AppStorageSnapshot,
  b: AppStorageSnapshot,
): boolean {
  return a.persisted === b.persisted &&
    a.usage === b.usage &&
    a.quota === b.quota &&
    a.usageRatio === b.usageRatio;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export type AppSyncStatus =
  | "IDLE"
  | "SYNCING"
  | "OFFLINE"
  | "BACKING_OFF"
  | "AUTH_BLOCKED"
  | "CONFLICTS"
  | "ERROR";

export type AppSyncSnapshot = {
  online: boolean;
  status: AppSyncStatus;
  pendingMutations: number;
  lastSyncedAt: string | null;
  lastErrorMessage: string | null;
  retryAt: string | null;
  conflictCount: number;
};

export type SyncStatusSource = {
  getSnapshot: () => Partial<AppSyncSnapshot>;
  subscribe?: (callback: () => void) => () => void;
  refresh?: () => void | Promise<void>;
  flush?: () => void | Promise<void>;
  retry?: () => void | Promise<void>;
};

const DEFAULT_SYNC: AppSyncSnapshot = {
  online: readNavigatorOnline(),
  status: "IDLE",
  pendingMutations: 0,
  lastSyncedAt: null,
  lastErrorMessage: null,
  retryAt: null,
  conflictCount: 0,
};

let syncSource: SyncStatusSource | null = null;
let syncSourceUnsubscribe: (() => void) | null = null;
let syncSnapshot: AppSyncSnapshot = DEFAULT_SYNC;
const syncListeners = new Set<() => void>();

export function configureSyncStatus(source: SyncStatusSource): () => void {
  syncSourceUnsubscribe?.();
  syncSource = source;
  syncSourceUnsubscribe = source.subscribe?.(refreshSyncSnapshot) ?? null;
  refreshSyncSnapshot();
  return () => {
    if (syncSource !== source) return;
    syncSourceUnsubscribe?.();
    syncSourceUnsubscribe = null;
    syncSource = null;
    setSyncSnapshot(normalizeSyncSnapshot({}));
  };
}

export function getSyncSnapshot(): AppSyncSnapshot {
  return syncSnapshot;
}

export function subscribeSyncSnapshot(callback: () => void): () => void {
  syncListeners.add(callback);
  return () => syncListeners.delete(callback);
}

export async function refreshSyncStatus(): Promise<void> {
  await syncSource?.refresh?.();
  refreshSyncSnapshot();
}

export async function flushSyncStatus(): Promise<void> {
  await syncSource?.flush?.();
  refreshSyncSnapshot();
}

export async function retrySyncStatus(): Promise<void> {
  await syncSource?.retry?.();
  refreshSyncSnapshot();
}

export function useSyncRefresh(): () => Promise<void> {
  return useCallback(() => refreshSyncStatus(), []);
}

export function useSyncFlush(): () => Promise<void> {
  return useCallback(() => flushSyncStatus(), []);
}

export function useSyncRetry(): () => Promise<void> {
  return useCallback(() => retrySyncStatus(), []);
}

export function syncLiveState<K extends keyof AppSyncSnapshot>(
  key: K,
): LiveState<AppSyncSnapshot[K]> {
  return {
    read: () => syncSnapshot[key],
    subscribe: subscribeSyncSnapshot,
  };
}

function refreshSyncSnapshot(): void {
  setSyncSnapshot(normalizeSyncSnapshot(syncSource?.getSnapshot() ?? {}));
}

function normalizeSyncSnapshot(
  partial: Partial<AppSyncSnapshot>,
): AppSyncSnapshot {
  const online = typeof partial.online === "boolean"
    ? partial.online
    : readNavigatorOnline();
  return {
    online,
    status: partial.status ?? (online ? "IDLE" : "OFFLINE"),
    pendingMutations: partial.pendingMutations ?? 0,
    lastSyncedAt: partial.lastSyncedAt ?? null,
    lastErrorMessage: partial.lastErrorMessage ?? null,
    retryAt: partial.retryAt ?? null,
    conflictCount: partial.conflictCount ?? 0,
  };
}

function readNavigatorOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return typeof navigator.onLine === "boolean" ? navigator.onLine : true;
}

function setSyncSnapshot(next: AppSyncSnapshot): void {
  if (syncSnapshotsEqual(syncSnapshot, next)) return;
  syncSnapshot = next;
  for (const listener of syncListeners) listener();
}

function syncSnapshotsEqual(a: AppSyncSnapshot, b: AppSyncSnapshot): boolean {
  return a.online === b.online &&
    a.status === b.status &&
    a.pendingMutations === b.pendingMutations &&
    a.lastSyncedAt === b.lastSyncedAt &&
    a.lastErrorMessage === b.lastErrorMessage &&
    a.retryAt === b.retryAt &&
    a.conflictCount === b.conflictCount;
}

if (typeof window !== "undefined") {
  window.addEventListener("online", refreshSyncSnapshot);
  window.addEventListener("offline", refreshSyncSnapshot);
}
