import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  configureSyncStatus,
  flushSyncStatus,
  getStorageSnapshot,
  getSyncSnapshot,
  refreshStorageSnapshot,
  requestStoragePersistence,
  retrySyncStatus,
  storageLiveState,
  syncLiveState,
} from "./app-graph.ts";

const originalStorageDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "storage",
);

afterEach(() => {
  restoreNavigatorStorage();
});

describe("app graph storage state", () => {
  test("refreshStorageSnapshot reads persisted/quota state", async () => {
    setNavigatorStorage({
      persisted: () => Promise.resolve(true),
      estimate: () => Promise.resolve({ usage: 25, quota: 100 }),
    });

    const snapshot = await refreshStorageSnapshot();

    expect(snapshot).toEqual({
      persisted: true,
      usage: 25,
      quota: 100,
      usageRatio: 0.25,
    });
    expect(getStorageSnapshot()).toEqual(snapshot);
  });

  test("requestStoragePersistence calls persist then refreshes storage state", async () => {
    const persist = mock(() => Promise.resolve(true));
    setNavigatorStorage({
      persist,
      persisted: () => Promise.resolve(true),
      estimate: () => Promise.resolve({ usage: 10, quota: 20 }),
    });

    const granted = await requestStoragePersistence();

    expect(granted).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(getStorageSnapshot().usageRatio).toBe(0.5);
  });

  test("storageLiveState notifies subscribers only when snapshot changes", async () => {
    let usage = 1;
    setNavigatorStorage({
      persisted: () => Promise.resolve(false),
      estimate: () => Promise.resolve({ usage, quota: 10 }),
    });
    await refreshStorageSnapshot();
    const live = storageLiveState("usage");
    const notify = mock(() => {});
    const unsubscribe = live.subscribe(notify);

    await refreshStorageSnapshot();
    usage = 2;
    await refreshStorageSnapshot();
    unsubscribe();
    usage = 3;
    await refreshStorageSnapshot();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(live.read()).toBe(3);
  });
});

describe("app graph sync state", () => {
  test("configureSyncStatus publishes app-owned sync state", async () => {
    let pendingMutations = 1;
    const listeners = new Set<() => void>();
    const cleanup = configureSyncStatus({
      getSnapshot: () => ({ status: "SYNCING", pendingMutations }),
      subscribe: (callback) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    });
    const live = syncLiveState("pendingMutations");
    const notify = mock(() => {});
    const unsubscribe = live.subscribe(notify);

    pendingMutations = 2;
    for (const listener of listeners) listener();

    expect(getSyncSnapshot().status).toBe("SYNCING");
    expect(live.read()).toBe(2);
    expect(notify).toHaveBeenCalledTimes(1);
    unsubscribe();
    cleanup();
  });

  test("sync action functions delegate to configured source", async () => {
    const flush = mock(() => Promise.resolve());
    const retry = mock(() => Promise.resolve());
    const cleanup = configureSyncStatus({
      getSnapshot: () => ({ status: "IDLE" }),
      flush,
      retry,
    });

    await flushSyncStatus();
    await retrySyncStatus();

    expect(flush).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledTimes(1);
    cleanup();
  });
});

function setNavigatorStorage(storage: Partial<StorageManager>): void {
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    value: storage,
  });
}

function restoreNavigatorStorage(): void {
  if (originalStorageDescriptor) {
    Object.defineProperty(navigator, "storage", originalStorageDescriptor);
  } else {
    delete (navigator as { storage?: StorageManager }).storage;
  }
}
