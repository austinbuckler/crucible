/** Maximum number of ordered changes requested by a single pull. */
export const SYNC_PULL_PAGE_SIZE = 500;

const MAX_PAGES_PER_CYCLE = 8;
const DEFAULT_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;
const LEADER_RETRY_MS = 1_500;
const SYNC_WAKE_MS = 30_000;

export type SyncCursor = {
  version: string;
  epoch?: string;
};

export type SyncPullPage<TChange = unknown> = {
  changes: TChange[];
  nextServerVersion: string;
  epoch?: string;
};

export type SingleWriterQueue = {
  run<T>(operation: () => T | Promise<T>): Promise<T>;
};

/** A per-Worker FIFO queue shared by local mutations and sync writes. */
export function createSingleWriterQueue(): SingleWriterQueue {
  let tail: Promise<void> = Promise.resolve();

  return {
    run<T>(operation: () => T | Promise<T>): Promise<T> {
      const result = tail.then(operation);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

export type SyncFlushContext = {
  /** Use this for SQLite reads/writes; leave network requests outside the queue. */
  runWrite: SingleWriterQueue["run"];
};

export type SyncApplyContext = {
  /** Check the app-owned outbox before merging a pulled row with a local id. */
  pendingByModelId(model: string, modelId: string): Promise<boolean>;
};

export type PushAdapter<TChange = unknown> = {
  subscribe(
    groupId: string,
    onEvents: (events: TChange[]) => void,
  ): void | Promise<void>;
  unsubscribe(groupId: string): void | Promise<void>;
};

export type HoldBackQueueOptions<TChange> = {
  /** Changes need a stable server log id, normally the AUTOINCREMENT id. */
  getId?: (change: TChange) => string | number | bigint;
};

function defaultChangeId(change: unknown): string | number | bigint {
  if (change == null || typeof change !== "object" || !("id" in change)) {
    throw new TypeError("A pushed sync change must include its ordered server `id`.");
  }
  const id = (change as { id: unknown }).id;
  if (typeof id !== "string" && typeof id !== "number" && typeof id !== "bigint") {
    throw new TypeError("A pushed sync change `id` must be an integer.");
  }
  return id;
}

function asWatermark(value: string | number | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`Invalid sync change id: ${value}`);
    }
    return BigInt(value);
  }
  if (!/^\d+$/.test(value)) throw new TypeError(`Invalid sync watermark: ${value}`);
  return BigInt(value);
}

function changeWatermark<TChange>(
  change: TChange,
  getId?: (change: TChange) => string | number | bigint,
): bigint {
  const id = getId ? getId(change) : defaultChangeId(change);
  return asWatermark(id);
}

/**
 * Buffers push notifications until a pull confirms the complete group feed
 * through a watermark. This makes global AUTOINCREMENT gaps safe while
 * preventing a fast socket event from overtaking slower pull results.
 */
export class HoldBackQueue<TChange = unknown> {
  private readonly getId: (change: TChange) => string | number | bigint;
  private readonly events = new Map<string, TChange>();

  constructor(options: HoldBackQueueOptions<TChange> = {}) {
    this.getId = options.getId ?? (defaultChangeId as (change: TChange) => string | number | bigint);
  }

  enqueueRemote(events: readonly TChange[]): void {
    for (const event of events) {
      const id = this.getId(event);
      const watermark = asWatermark(id);
      const key = watermark.toString();
      if (!this.events.has(key)) this.events.set(key, event);
    }
  }

  /** Pulled rows are authoritative and replace a possibly abbreviated push event. */
  enqueuePulled(events: readonly TChange[]): void {
    for (const event of events) {
      const watermark = asWatermark(this.getId(event));
      this.events.set(watermark.toString(), event);
    }
  }

  /**
   * Return ordered events after `cursor` covered by a completed pull through
   * `watermark`. Call only after the pull adapter has returned the complete,
   * sync-group-scoped page up to that watermark.
   */
  async applyUpTo(
    cursor: string,
    watermark: string,
    apply: (events: TChange[]) => void | Promise<void>,
  ): Promise<TChange[]> {
    const after = asWatermark(cursor);
    const through = asWatermark(watermark);
    if (through < after) throw new Error("A sync pull cannot move its watermark backwards.");

    const ready = [...this.events.entries()]
      .map(([id, change]) => ({ id: BigInt(id), change }))
      .filter(({ id }) => id > after && id <= through)
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

    const changes = ready.map(({ change }) => change);
    await apply(changes);
    // The successful catch-up pull proves there are no unseen group rows up
    // to this watermark, including push events received while apply awaited.
    this.discardThrough(watermark);
    return changes;
  }

  discardThrough(watermark: string): void {
    const through = asWatermark(watermark);
    for (const id of this.events.keys()) {
      if (BigInt(id) <= through) this.events.delete(id);
    }
  }

  clear(): void {
    this.events.clear();
  }

  get size(): number {
    return this.events.size;
  }
}

export type SyncStatus = "LOCAL_DRAFT" | "PENDING_FLUSH" | "PENDING_ACK" | "SYNCED";

export type SyncRuntimeSnapshot = {
  isLeader: boolean;
  isOnline: boolean;
  pendingCount: number;
  lastError: string | null;
};

export type SyncAcknowledgementBarrier = {
  groupId?: string;
  serverVersion: string;
};

export type SyncStatusStore = {
  /** Read pending rows from the app-owned outbox. */
  pendingCount?(): Promise<number>;
  /** Read the app-owned outbox for this domain model and row id. */
  hasPendingOutbox?(model: string, modelId: string): Promise<boolean>;
  /** Return the accepted mutation's server watermark, if one is outstanding. */
  getAcknowledgementBarrier?(
    model: string,
    modelId: string,
  ): Promise<SyncAcknowledgementBarrier | null>;
  /** Optional app policy for rows that have not entered the outbox yet. */
  isLocalDraft?(model: string, modelId: string): Promise<boolean>;
};

export type SyncRuntimeOptions<TChange = unknown> = {
  groupId: string | (() => string);
  /** Flush app-owned outbox rows; accepted barriers stay app-owned. */
  flush(context: SyncFlushContext): Promise<void>;
  /** Pull a complete sync-group page after `since`, capped by `limit`. */
  pull(
    since: string,
    epoch?: string,
    limit?: number,
  ): Promise<SyncPullPage<TChange>>;
  /** Idempotently merge rows; preserve fields with a still-pending local write. */
  apply(changes: TChange[], context: SyncApplyContext): Promise<void>;
  getCursor(groupId: string): Promise<SyncCursor>;
  setCursor(groupId: string, version: string, epoch?: string): Promise<void>;
  /** Publish the same app-local events used by local mutations after commit. */
  publishApplied?(changes: TChange[]): void | Promise<void>;
  /** Share this queue with local GraphQL mutations and sync's apply/cursor writes. */
  writerQueue?: SingleWriterQueue;
  /** Storage callbacks used by computed sync status. */
  status?: SyncStatusStore;
  /** Optional live push adapter. Pull remains the authority for feed completeness. */
  push?: PushAdapter<TChange>;
  /** Extract log ids if the event shape does not use `{ id }`. */
  getChangeId?: (change: TChange) => string | number | bigint;
  /** Called after the server reports a new log generation. */
  onEpochChange?: (previous: string | undefined, next: string) => void | Promise<void>;
  /** Changes how often an idle leader checks for new work. */
  pollIntervalMs?: number;
  /** Change the lock namespace when multiple Crucible apps share an origin. */
  lockName?: string;
};

export type SyncRuntime = {
  readonly isLeader: boolean;
  readonly isOnline: boolean;
  readonly pendingCount: number;
  readonly lastError: string | null;
  start(): Promise<void>;
  stop(): Promise<void>;
  pause(): void;
  resume(): void;
  poke(): void;
  /** Network state forwarded by the local GraphQL host when Worker events are unavailable. */
  setOnline(online: boolean): void;
  getSnapshot(): SyncRuntimeSnapshot;
  subscribe(listener: (snapshot: SyncRuntimeSnapshot) => void): () => void;
  pendingByModelId(model: string, modelId: string): Promise<boolean>;
  syncStatusFor(model: string, modelId: string, groupId?: string): Promise<SyncStatus>;
  /** Shared write queue for app local mutations and sync apply/cursor writes. */
  runWrite: SingleWriterQueue["run"];
};

type LockHandle = {
  request: (
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: unknown | null) => Promise<void>,
  ) => Promise<void>;
};

type RuntimeEventScope = {
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
};

function currentGroupId(groupId: string | (() => string)): string {
  const value = typeof groupId === "function" ? groupId() : groupId;
  if (!value) throw new Error("Sync runtime groupId must not be empty.");
  return value;
}

function onlineNow(): boolean {
  return typeof navigator === "undefined" || typeof navigator.onLine !== "boolean"
    ? true
    : navigator.onLine;
}

function cursorIsAheadOrEqual(left: string, right: string): boolean {
  return asWatermark(left) >= asWatermark(right);
}

function createWakeSignal() {
  let resolveWake: (() => void) | null = null;
  let pending = false;
  return {
    wake() {
      pending = true;
      resolveWake?.();
      resolveWake = null;
    },
    wait(ms: number): Promise<void> {
      if (pending) {
        pending = false;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          pending = false;
          clearTimeout(timer);
          resolveWake = null;
          resolve();
        };
        const timer = setTimeout(finish, ms);
        resolveWake = finish;
      });
    },
  };
}

/**
 * Runs the app's ordered replication protocol in its local GraphQL Worker.
 * Relay never participates in flush, pull, apply, leader election, or status.
 */
export function createSyncRuntime<TChange = unknown>(
  options: SyncRuntimeOptions<TChange>,
): SyncRuntime {
  const writerQueue = options.writerQueue ?? createSingleWriterQueue();
  const groupId = () => currentGroupId(options.groupId);
  const holdBack = options.push
    ? new HoldBackQueue<TChange>({ getId: options.getChangeId })
    : null;
  const statusListeners = new Set<(snapshot: SyncRuntimeSnapshot) => void>();
  const wake = createWakeSignal();
  const instanceId = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  const runtimeNamespace = options.lockName ?? "crucible:sync-runtime";
  const channel =
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel(`crucible:sync-runtime:${encodeURIComponent(runtimeNamespace)}`);
  let started = false;
  let paused = false;
  let stopped = false;
  let isLeader = false;
  let isOnline = onlineNow();
  let pendingCount = 0;
  let lastError: string | null = null;
  let electionTask: Promise<void> | null = null;
  let leaderId: string | null = null;
  let pushSubscribedFor: string | null = null;
  let retryMs = DEFAULT_RETRY_MS;

  const snapshot = (): SyncRuntimeSnapshot => ({ isLeader, isOnline, pendingCount, lastError });
  const publishSnapshot = () => {
    const state = snapshot();
    for (const listener of statusListeners) listener(state);
    channel?.postMessage({
      type: "state",
      instanceId,
      isLeader,
      isOnline,
      pendingCount,
      lastError,
    });
  };
  const refreshPendingCount = async () => {
    if (!options.status?.pendingCount) return;
    try {
      pendingCount = await options.status.pendingCount();
      publishSnapshot();
    } catch (error) {
      recordError(error);
    }
  };
  const pendingByModelId = async (model: string, modelId: string) =>
    (await options.status?.hasPendingOutbox?.(model, modelId)) ?? false;
  const recordError = (error: unknown) => {
    lastError = error instanceof Error ? error.message : String(error);
    publishSnapshot();
  };
  const clearError = () => {
    if (lastError == null) return;
    lastError = null;
    publishSnapshot();
  };
  const setLeader = (next: boolean) => {
    if (isLeader === next) return;
    isLeader = next;
    if (next) leaderId = instanceId;
    else if (leaderId === instanceId) leaderId = null;
    publishSnapshot();
  };

  async function subscribeToPush(activeGroupId: string): Promise<void> {
    if (!options.push || pushSubscribedFor === activeGroupId) return;
    await unsubscribeFromPush();
    await options.push.subscribe(activeGroupId, (events) => {
      if (!isLeader || !holdBack) return;
      try {
        holdBack.enqueueRemote(events);
        wake.wake();
      } catch (error) {
        recordError(error);
      }
    });
    pushSubscribedFor = activeGroupId;
  }

  async function unsubscribeFromPush(): Promise<void> {
    const activeGroupId = pushSubscribedFor;
    if (!options.push || !activeGroupId) return;
    pushSubscribedFor = null;
    await options.push.unsubscribe(activeGroupId);
  }

  async function applyPage(
    changes: TChange[],
    activeGroupId: string,
    nextVersion: string,
    epoch: string | undefined,
  ): Promise<void> {
    if (changes.length === 0) {
      await writerQueue.run(() => options.setCursor(activeGroupId, nextVersion, epoch));
      return;
    }

    await writerQueue.run(async () => {
      await options.apply(changes, { pendingByModelId });
      await options.publishApplied?.(changes);
      await options.setCursor(activeGroupId, nextVersion, epoch);
    });
    await refreshPendingCount();
  }

  async function syncCycle(): Promise<void> {
    const activeGroupId = groupId();
    await subscribeToPush(activeGroupId);
    await options.flush({ runWrite: writerQueue.run });
    await refreshPendingCount();

    let cursor = await options.getCursor(activeGroupId);
    let pages = 0;
    let changesInLastPage = 0;
    while (pages < MAX_PAGES_PER_CYCLE && isLeader && isOnline && !paused && !stopped) {
      const page = await options.pull(cursor.version, cursor.epoch, SYNC_PULL_PAGE_SIZE);
      pages++;

      if (!Array.isArray(page.changes)) throw new TypeError("Sync pull changes must be an array.");
      if (page.changes.length > SYNC_PULL_PAGE_SIZE) {
        throw new Error(`Sync pull returned more than ${SYNC_PULL_PAGE_SIZE} changes.`);
      }
      const nextVersion = String(page.nextServerVersion);
      const nextWatermark = asWatermark(nextVersion);

      if (groupId() !== activeGroupId) {
        holdBack?.clear();
        await unsubscribeFromPush();
        return;
      }

      if (page.epoch && cursor.epoch && page.epoch !== cursor.epoch) {
        holdBack?.clear();
        await options.onEpochChange?.(cursor.epoch, page.epoch);
        await writerQueue.run(() => options.setCursor(activeGroupId, "0", page.epoch));
        cursor = { version: "0", epoch: page.epoch };
        changesInLastPage = SYNC_PULL_PAGE_SIZE;
        continue;
      }

      if (page.epoch && !cursor.epoch && cursor.version !== "0") {
        holdBack?.clear();
        await options.onEpochChange?.(undefined, page.epoch);
        await writerQueue.run(() => options.setCursor(activeGroupId, "0", page.epoch));
        cursor = { version: "0", epoch: page.epoch };
        changesInLastPage = SYNC_PULL_PAGE_SIZE;
        continue;
      }

      if (nextWatermark < asWatermark(cursor.version)) {
        throw new Error("Sync pull returned a watermark older than the current cursor.");
      }
      if (page.changes.length === 0 && nextWatermark !== asWatermark(cursor.version)) {
        throw new Error("An empty sync page must keep the current server watermark.");
      }
      let lastChangeWatermark = asWatermark(cursor.version);
      for (const change of page.changes) {
        const changeId = changeWatermark(change, options.getChangeId);
        if (changeId <= lastChangeWatermark) {
          throw new Error("Sync pull changes must be ordered after the current cursor.");
        }
        lastChangeWatermark = changeId;
      }
      if (page.changes.length > 0 && lastChangeWatermark !== nextWatermark) {
        throw new Error("nextServerVersion must equal the last change id in the pulled page.");
      }

      const epoch = page.epoch ?? cursor.epoch;
      let changesToApply = page.changes;
      const shouldAdvance =
        page.changes.length > 0 ||
        nextWatermark > asWatermark(cursor.version) ||
        epoch !== cursor.epoch;
      if (holdBack) {
        // A completed group pull establishes coverage to nextVersion. Push
        // events beyond it remain buffered until a later catch-up page.
        holdBack.enqueuePulled(page.changes);
        changesToApply = await holdBack.applyUpTo(cursor.version, nextVersion, async (ready) => {
          if (shouldAdvance) await applyPage(ready, activeGroupId, nextVersion, epoch);
        });
      }

      changesInLastPage = page.changes.length;
      if (shouldAdvance) {
        if (!holdBack) await applyPage(changesToApply, activeGroupId, nextVersion, epoch);
        cursor = { version: nextVersion, epoch };
      }

      if (page.changes.length < SYNC_PULL_PAGE_SIZE) break;
    }

    if (changesInLastPage === SYNC_PULL_PAGE_SIZE) {
      // Yield to other Worker work and schedule another bounded catch-up burst.
      setTimeout(() => wake.wake(), 0);
    }
    clearError();
  }

  async function leaderLoop(): Promise<void> {
    retryMs = DEFAULT_RETRY_MS;
    while (started && !paused && !stopped && isLeader) {
      if (!isOnline) {
        await wake.wait(SYNC_WAKE_MS);
        continue;
      }

      try {
        await syncCycle();
        retryMs = DEFAULT_RETRY_MS;
      } catch (error) {
        recordError(error);
        await wake.wait(retryMs);
        retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
        continue;
      }

      await wake.wait(options.pollIntervalMs ?? SYNC_WAKE_MS);
    }
  }

  async function electionLoop(): Promise<void> {
    const lockManager = (typeof navigator === "undefined" ? undefined : navigator.locks) as
      | LockHandle
      | undefined;
    // The lock protects the shared SQLite file, so it is app scoped rather
    // than group scoped: changing workspaces must not create a second leader.
    const lockName = runtimeNamespace;

    while (started && !stopped) {
      if (paused || !isOnline) {
        setLeader(false);
        await unsubscribeFromPush();
        await wake.wait(SYNC_WAKE_MS);
        continue;
      }
      if (!lockManager) {
        recordError("Sync runtime requires navigator.locks to protect the shared SQLite writer.");
        await wake.wait(MAX_RETRY_MS);
        continue;
      }

      let acquired = false;
      try {
        await lockManager.request(lockName, { mode: "exclusive", ifAvailable: true }, async (lock) => {
          if (!lock) return;
          acquired = true;
          setLeader(true);
          await leaderLoop();
          setLeader(false);
          await unsubscribeFromPush();
        });
        if (!acquired && started && !paused && isOnline) await wake.wait(LEADER_RETRY_MS);
      } catch (error) {
        setLeader(false);
        await unsubscribeFromPush();
        recordError(error);
        await wake.wait(retryMs);
        retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
      }
    }
  }

  const eventScope = globalThis as unknown as RuntimeEventScope;
  const onOnline = () => {
    isOnline = true;
    publishSnapshot();
    wake.wake();
  };
  const onOffline = () => {
    isOnline = false;
    publishSnapshot();
    wake.wake();
  };

  channel?.addEventListener("message", (event: MessageEvent<unknown>) => {
    const value = event.data as {
      type?: unknown;
      instanceId?: unknown;
      isLeader?: unknown;
      pendingCount?: unknown;
      lastError?: unknown;
    } | null;
    if (!value || value.type !== "state" || value.instanceId === instanceId) return;
    const messageInstanceId = String(value.instanceId);
    const cameFromLeader = value.isLeader === true || leaderId === messageInstanceId;
    if (value.isLeader === true) leaderId = messageInstanceId;
    else if (leaderId === value.instanceId) leaderId = null;
    if (!cameFromLeader) return;
    let changed = false;
    if (typeof value.pendingCount === "number" && value.pendingCount !== pendingCount) {
      pendingCount = value.pendingCount;
      changed = true;
    }
    if (
      (typeof value.lastError === "string" || value.lastError === null) &&
      value.lastError !== lastError
    ) {
      lastError = value.lastError;
      changed = true;
    }
    if (changed) {
      const state = snapshot();
      for (const listener of statusListeners) listener(state);
    }
  });

  const runtime: SyncRuntime = {
    get isLeader() {
      return isLeader;
    },
    get isOnline() {
      return isOnline;
    },
    get pendingCount() {
      return pendingCount;
    },
    get lastError() {
      return lastError;
    },
    async start() {
      if (started && !stopped) return;
      started = true;
      stopped = false;
      isOnline = onlineNow();
      eventScope.addEventListener?.("online", onOnline);
      eventScope.addEventListener?.("offline", onOffline);
      await refreshPendingCount();
      electionTask = electionLoop();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      started = false;
      eventScope.removeEventListener?.("online", onOnline);
      eventScope.removeEventListener?.("offline", onOffline);
      wake.wake();
      await electionTask;
      electionTask = null;
      setLeader(false);
      await unsubscribeFromPush();
      channel?.close();
    },
    pause() {
      paused = true;
      wake.wake();
    },
    resume() {
      paused = false;
      wake.wake();
    },
    poke() {
      void refreshPendingCount();
      wake.wake();
    },
    setOnline(online) {
      isOnline = online;
      publishSnapshot();
      wake.wake();
    },
    getSnapshot: snapshot,
    subscribe(listener) {
      statusListeners.add(listener);
      listener(snapshot());
      return () => statusListeners.delete(listener);
    },
    async pendingByModelId(model, modelId) {
      return pendingByModelId(model, modelId);
    },
    async syncStatusFor(model, modelId, requestedGroupId) {
      if ((await options.status?.isLocalDraft?.(model, modelId)) ?? false) return "LOCAL_DRAFT";
      if (await runtime.pendingByModelId(model, modelId)) return "PENDING_FLUSH";
      const barrier = await options.status?.getAcknowledgementBarrier?.(model, modelId);
      if (!barrier) return "SYNCED";
      const barrierGroupId = barrier.groupId ?? requestedGroupId ?? groupId();
      const cursor = await options.getCursor(barrierGroupId);
      return cursorIsAheadOrEqual(cursor.version, barrier.serverVersion) ? "SYNCED" : "PENDING_ACK";
    },
    runWrite: writerQueue.run,
  };

  return runtime;
}

export type SyncCursorKeyValueStore = {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string): Promise<void>;
  delete?(key: string): Promise<void>;
};

export function syncCursorVersionKey(groupId: string): string {
  return `serverVersion:${groupId}`;
}

export function syncCursorEpochKey(groupId: string): string {
  return `serverEpoch:${groupId}`;
}

/** Build the per-group cursor callbacks from the app's sync_state key/value table. */
export function createSyncCursorHelpers(store: SyncCursorKeyValueStore): {
  getCursor(groupId: string): Promise<SyncCursor>;
  setCursor(groupId: string, version: string, epoch?: string): Promise<void>;
} {
  return {
    async getCursor(groupId) {
      const [version, epoch] = await Promise.all([
        store.get(syncCursorVersionKey(groupId)),
        store.get(syncCursorEpochKey(groupId)),
      ]);
      return { version: version ?? "0", ...(epoch ? { epoch } : {}) };
    },
    async setCursor(groupId, version, epoch) {
      await store.set(syncCursorVersionKey(groupId), version);
      if (epoch) {
        await store.set(syncCursorEpochKey(groupId), epoch);
      } else if (store.delete) {
        await store.delete(syncCursorEpochKey(groupId));
      } else {
        await store.set(syncCursorEpochKey(groupId), "");
      }
    },
  };
}
