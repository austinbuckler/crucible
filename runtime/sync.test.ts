import { afterEach, describe, expect, test } from "bun:test";
import {
  createSingleWriterQueue,
  createSyncCursorHelpers,
  createSyncRuntime,
  HoldBackQueue,
  SYNC_PULL_PAGE_SIZE,
  syncCursorEpochKey,
  syncCursorVersionKey,
  type PushAdapter,
} from "./sync.ts";

type FakeLockManager = {
  request(
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: unknown | null) => Promise<void>,
  ): Promise<void>;
};

const originalOnlineDescriptor = Object.getOwnPropertyDescriptor(navigator, "onLine");
const originalLocksDescriptor = Object.getOwnPropertyDescriptor(navigator, "locks");

afterEach(() => {
  restoreNavigatorProperty("onLine", originalOnlineDescriptor);
  restoreNavigatorProperty("locks", originalLocksDescriptor);
});

function restoreNavigatorProperty(key: "onLine" | "locks", descriptor?: PropertyDescriptor) {
  if (descriptor) Object.defineProperty(navigator, key, descriptor);
  else Reflect.deleteProperty(navigator, key);
}

function installLockManager(locks: FakeLockManager, online = true): void {
  Object.defineProperty(navigator, "onLine", { configurable: true, value: online });
  Object.defineProperty(navigator, "locks", { configurable: true, value: locks });
}

function immediateLockManager(): FakeLockManager {
  return {
    async request(_name, _options, callback) {
      await callback({});
    },
  };
}

function sharedLockManager(): FakeLockManager {
  let held = false;
  return {
    async request(_name, _options, callback) {
      if (held) {
        await callback(null);
        return;
      }
      held = true;
      try {
        await callback({});
      } finally {
        held = false;
      }
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for sync runtime state.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createSingleWriterQueue", () => {
  test("serializes writes and continues after a rejected write", async () => {
    const queue = createSingleWriterQueue();
    const events: string[] = [];
    const gate = deferred<void>();

    const first = queue.run(async () => {
      events.push("first:start");
      await gate.promise;
      events.push("first:end");
    });
    const second = queue.run(() => events.push("second"));

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    gate.resolve();
    await Promise.all([first, second]);

    const rejected = queue.run(() => {
      throw new Error("write failed");
    });
    await expect(rejected).rejects.toThrow("write failed");
    await queue.run(() => events.push("after-error"));

    expect(events).toEqual(["first:start", "first:end", "second", "after-error"]);
  });
});

describe("HoldBackQueue", () => {
  test("holds push id 109 until pull coverage reaches it, then uses the pulled row", async () => {
    const queue = new HoldBackQueue<{ id: number; source: string }>();
    queue.enqueueRemote([{ id: 109, source: "socket" }]);

    queue.enqueuePulled([
      { id: 106, source: "pull" },
      { id: 107, source: "pull" },
      { id: 108, source: "pull" },
    ]);
    const firstApplied: number[] = [];
    const first = await queue.applyUpTo("105", "108", (changes) => {
      firstApplied.push(...changes.map((change) => change.id));
    });

    expect(first.map((change) => change.id)).toEqual([106, 107, 108]);
    expect(firstApplied).toEqual([106, 107, 108]);
    expect(queue.size).toBe(1);

    queue.enqueuePulled([{ id: 109, source: "pull" }]);
    const second = await queue.applyUpTo("108", "109", () => {});
    expect(second).toEqual([{ id: 109, source: "pull" }]);
    expect(queue.size).toBe(0);
  });

  test("does not discard buffered rows when apply fails", async () => {
    const queue = new HoldBackQueue<{ id: number }>();
    queue.enqueueRemote([{ id: 4 }]);

    await expect(
      queue.applyUpTo("3", "4", () => {
        throw new Error("SQLite apply failed");
      }),
    ).rejects.toThrow("SQLite apply failed");

    expect(queue.size).toBe(1);
  });
});

describe("sync cursor helpers", () => {
  test("stores independent version and epoch keys for each sync group", async () => {
    const values = new Map<string, string>();
    const store = {
      async get(key: string) {
        return values.get(key);
      },
      async set(key: string, value: string) {
        values.set(key, value);
      },
      async delete(key: string) {
        values.delete(key);
      },
    };
    const cursors = createSyncCursorHelpers(store);

    await cursors.setCursor("workspace-a", "42", "epoch-a");
    await cursors.setCursor("workspace-b", "7");

    expect(syncCursorVersionKey("workspace-a")).toBe("serverVersion:workspace-a");
    expect(syncCursorEpochKey("workspace-a")).toBe("serverEpoch:workspace-a");
    expect(await cursors.getCursor("workspace-a")).toEqual({ version: "42", epoch: "epoch-a" });
    expect(await cursors.getCursor("workspace-b")).toEqual({ version: "7" });
  });
});

describe("createSyncRuntime", () => {
  test("flushes before pulling, applies through the writer queue, publishes, and advances the group cursor", async () => {
    installLockManager(immediateLockManager());
    const sequence: string[] = [];
    const cursor = { version: "105", epoch: "epoch-a" };
    let sawPendingDirtyRow = false;
    const runtime = createSyncRuntime({
      groupId: "workspace-a",
      lockName: "sync-test:ordered-cycle",
      pollIntervalMs: 60_000,
      flush: async ({ runWrite }) => {
        sequence.push("flush");
        await runWrite(() => sequence.push("flush-write"));
      },
      pull: async (since, epoch, limit) => {
        sequence.push(`pull:${since}:${epoch}:${limit}`);
        return {
          changes: [{ id: 106, modelId: "todo-1" }, { id: 108, modelId: "todo-1" }],
          nextServerVersion: "108",
          epoch: "epoch-a",
        };
      },
      apply: async (changes, context) => {
        sequence.push("apply");
        sawPendingDirtyRow = await context.pendingByModelId("todo", "todo-1");
        expect(changes.map((change) => change.id)).toEqual([106, 108]);
      },
      publishApplied: async () => {
        sequence.push("publish");
      },
      getCursor: async () => ({ ...cursor }),
      setCursor: async (groupId, version, epoch) => {
        sequence.push("cursor");
        expect(groupId).toBe("workspace-a");
        Object.assign(cursor, { version, epoch });
      },
      status: {
        hasPendingOutbox: async () => true,
      },
    });

    try {
      await runtime.start();
      await waitFor(() => cursor.version === "108");

      expect(SYNC_PULL_PAGE_SIZE).toBe(500);
      expect(sawPendingDirtyRow).toBe(true);
      expect(sequence).toEqual([
        "flush",
        "flush-write",
        "pull:105:epoch-a:500",
        "apply",
        "publish",
        "cursor",
      ]);
    } finally {
      await runtime.stop();
    }
  });

  test("uses the hold-back queue when push arrives during a slower pull", async () => {
    installLockManager(immediateLockManager());
    const firstPull = deferred<{
      changes: Array<{ id: number; source: string }>;
      nextServerVersion: string;
    }>();
    const firstPullStarted = deferred<void>();
    let onPush: ((events: Array<{ id: number; source: string }>) => void) | undefined;
    let pulls = 0;
    const applied: number[][] = [];
    const sources: string[][] = [];
    const cursor = { version: "105" };
    const push: PushAdapter<{ id: number; source: string }> = {
      subscribe: (_groupId, callback) => {
        onPush = callback;
      },
      unsubscribe: () => {},
    };
    const runtime = createSyncRuntime({
      groupId: "workspace-a",
      lockName: "sync-test:push-race",
      pollIntervalMs: 60_000,
      push,
      flush: async () => {},
      pull: async () => {
        pulls++;
        if (pulls === 1) {
          firstPullStarted.resolve();
          return firstPull.promise;
        }
        if (pulls === 2) {
          return {
            changes: [{ id: 109, source: "pull" }],
            nextServerVersion: "109",
          };
        }
        return { changes: [], nextServerVersion: "109" };
      },
      apply: async (changes) => {
        applied.push(changes.map((change) => change.id));
        sources.push(changes.map((change) => change.source));
      },
      getCursor: async () => ({ ...cursor }),
      setCursor: async (_groupId, version) => {
        cursor.version = version;
      },
    });

    try {
      await runtime.start();
      await firstPullStarted.promise;
      onPush?.([{ id: 109, source: "socket" }]);
      firstPull.resolve({
        changes: [
          { id: 106, source: "pull" },
          { id: 107, source: "pull" },
          { id: 108, source: "pull" },
        ],
        nextServerVersion: "108",
      });

      await waitFor(() => cursor.version === "109");
      await waitFor(() => applied.length === 2);
      expect(applied).toEqual([[106, 107, 108], [109]]);
      expect(sources).toEqual([
        ["pull", "pull", "pull"],
        ["pull"],
      ]);
      expect(pulls).toBe(2);
    } finally {
      await runtime.stop();
    }
  });

  test("resets the cursor on epoch change and re-pulls from the new generation", async () => {
    installLockManager(immediateLockManager());
    const cursor = { version: "75", epoch: "old-epoch" };
    const pullArgs: Array<[string, string | undefined]> = [];
    let epochChanges = 0;
    const runtime = createSyncRuntime({
      groupId: "workspace-a",
      lockName: "sync-test:epoch-change",
      pollIntervalMs: 60_000,
      flush: async () => {},
      pull: async (since, epoch) => {
        pullArgs.push([since, epoch]);
        return {
          changes: [{ id: 2 }],
          nextServerVersion: "2",
          epoch: "new-epoch",
        };
      },
      apply: async (changes) => {
        expect(changes).toEqual([{ id: 2 }]);
      },
      getCursor: async () => ({ ...cursor }),
      setCursor: async (_groupId, version, epoch) => {
        cursor.version = version;
        cursor.epoch = epoch ?? "";
      },
      onEpochChange: async (previous, next) => {
        expect(previous).toBe("old-epoch");
        expect(next).toBe("new-epoch");
        epochChanges++;
      },
    });

    try {
      await runtime.start();
      await waitFor(() => cursor.version === "2");
      expect(pullArgs).toEqual([["75", "old-epoch"], ["0", "new-epoch"]]);
      expect(epochChanges).toBe(1);
    } finally {
      await runtime.stop();
    }
  });

  test("computes draft, pending flush, pending acknowledgement, and synced status from metadata", async () => {
    let draft = true;
    let outbox = true;
    let barrier: { groupId: string; serverVersion: string } | null = {
      groupId: "workspace-b",
      serverVersion: "18",
    };
    const cursors = new Map([
      ["workspace-a", { version: "100" }],
      ["workspace-b", { version: "17" }],
    ]);
    const runtime = createSyncRuntime({
      groupId: "workspace-a",
      lockName: "sync-test:computed-status",
      flush: async () => {},
      pull: async (since) => ({ changes: [], nextServerVersion: since }),
      apply: async () => {},
      getCursor: async (groupId) => cursors.get(groupId) ?? { version: "0" },
      setCursor: async () => {},
      status: {
        isLocalDraft: async () => draft,
        hasPendingOutbox: async () => outbox,
        getAcknowledgementBarrier: async () => barrier,
      },
    });

    try {
      expect(await runtime.syncStatusFor("todo", "1")).toBe("LOCAL_DRAFT");
      draft = false;
      expect(await runtime.syncStatusFor("todo", "1")).toBe("PENDING_FLUSH");
      outbox = false;
      expect(await runtime.syncStatusFor("todo", "1")).toBe("PENDING_ACK");
      cursors.set("workspace-b", { version: "18" });
      expect(await runtime.syncStatusFor("todo", "1")).toBe("SYNCED");
      barrier = null;
      expect(await runtime.syncStatusFor("todo", "1")).toBe("SYNCED");
    } finally {
      await runtime.stop();
    }
  });

  test("only one runtime holding the shared Web Lock becomes leader", async () => {
    installLockManager(sharedLockManager());
    let flushCount = 0;
    const makeRuntime = () => createSyncRuntime({
      groupId: "workspace-a",
      lockName: "sync-test:shared-file",
      pollIntervalMs: 60_000,
      flush: async () => {
        flushCount++;
      },
      pull: async (since) => ({ changes: [], nextServerVersion: since }),
      apply: async () => {},
      getCursor: async () => ({ version: "0" }),
      setCursor: async () => {},
    });
    const first = makeRuntime();
    const second = makeRuntime();

    try {
      await Promise.all([first.start(), second.start()]);
      await waitFor(() => first.isLeader || second.isLeader);
      await waitFor(() => flushCount === 1);
      expect(first.isLeader).not.toBe(second.isLeader);
      expect(flushCount).toBe(1);
    } finally {
      await Promise.all([first.stop(), second.stop()]);
    }
  });

  test("pause relinquishes leadership and resume starts another sync cycle", async () => {
    installLockManager(immediateLockManager());
    let flushCount = 0;
    const runtime = createSyncRuntime({
      groupId: "workspace-a",
      lockName: "sync-test:pause-resume",
      pollIntervalMs: 60_000,
      flush: async () => {
        flushCount++;
      },
      pull: async (since) => ({ changes: [], nextServerVersion: since }),
      apply: async () => {},
      getCursor: async () => ({ version: "0" }),
      setCursor: async () => {},
    });

    try {
      await runtime.start();
      await waitFor(() => flushCount === 1);
      runtime.pause();
      await waitFor(() => !runtime.isLeader);
      const pausedFlushCount = flushCount;
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(flushCount).toBe(pausedFlushCount);

      runtime.resume();
      await waitFor(() => flushCount > pausedFlushCount);
    } finally {
      await runtime.stop();
    }
  });

  test("automatically retries a failed cycle after the backoff delay", async () => {
    installLockManager(immediateLockManager());
    let flushCount = 0;
    const cursor = { version: "0" };
    const runtime = createSyncRuntime({
      groupId: "workspace-a",
      lockName: "sync-test:automatic-backoff",
      pollIntervalMs: 60_000,
      flush: async () => {
        flushCount++;
        if (flushCount === 1) throw new Error("temporary server error");
      },
      pull: async (since) => since === "0"
        ? { changes: [{ id: 1 }], nextServerVersion: "1" }
        : { changes: [], nextServerVersion: since },
      apply: async () => {},
      getCursor: async () => ({ ...cursor }),
      setCursor: async (_groupId, version) => {
        cursor.version = version;
      },
    });

    try {
      await runtime.start();
      await waitFor(() => runtime.lastError === "temporary server error");
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(flushCount).toBe(1);

      await waitFor(() => cursor.version === "1", 2_000);
      expect(flushCount).toBe(2);
      expect(runtime.lastError).toBe(null);
    } finally {
      await runtime.stop();
    }
  });

  test("waits while offline and resumes after an online signal; poke retries after an error", async () => {
    installLockManager(immediateLockManager(), false);
    let flushCount = 0;
    let failFirstFlush = true;
    const cursor = { version: "0" };
    const runtime = createSyncRuntime({
      groupId: "workspace-a",
      lockName: "sync-test:offline-retry",
      pollIntervalMs: 60_000,
      flush: async () => {
        flushCount++;
        if (failFirstFlush) {
          failFirstFlush = false;
          throw new Error("temporary sync failure");
        }
      },
      pull: async (since) => since === "0"
        ? { changes: [{ id: 1 }], nextServerVersion: "1" }
        : { changes: [], nextServerVersion: since },
      apply: async () => {},
      getCursor: async () => ({ ...cursor }),
      setCursor: async (_groupId, version) => {
        cursor.version = version;
      },
    });

    try {
      await runtime.start();
      expect(runtime.isOnline).toBe(false);
      expect(flushCount).toBe(0);

      runtime.setOnline(true);
      await waitFor(() => runtime.lastError === "temporary sync failure");
      expect(flushCount).toBe(1);

      runtime.poke();
      await waitFor(() => cursor.version === "1");
      expect(runtime.lastError).toBe(null);
      expect(flushCount).toBe(2);

      runtime.setOnline(false);
      const countWhileOffline = flushCount;
      runtime.setOnline(true);
      await waitFor(() => flushCount > countWhileOffline);
    } finally {
      await runtime.stop();
    }
  });
});
