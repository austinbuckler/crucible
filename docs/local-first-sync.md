# Local-first sync

Crucible runs the client side of an ordered replication protocol beside the local GraphQL executor. Relay continues to read and write through local GraphQL; it does not know whether a row came from a local mutation, a pull, or a live push.

## Ownership

Crucible owns route preloading, the Relay environment, local GraphQL adapters, Worker boot, and the Worker sync runtime. The runtime flushes the app outbox, pulls changes, applies them, advances cursors, retries with backoff, pauses while offline, and elects one tab's Worker as the sync leader. It also provides per-group cursor helpers, computed status helpers, and an optional hold-back queue for apps that already have a push transport.

The app owns domain tables, outbox and acknowledgement-barrier storage, conflict rules, authentication, sync-group identity, the server endpoints, each model's `applyRemoteChange` behavior, and the adapters passed to Crucible. In particular, Crucible does not generate outbox tables from routes or choose whether a workspace, organization, or document is a sync group.

When `localGraphQL` is present, generated boot code disables Relay RecordSource persistence by default. Keep normalized Relay data out of a second durable store unless the app has a specific reason to persist it separately from SQLite.

## Replication model

Use a monotonic integer watermark over a **server-total-ordered, sync-group-scoped change log**. This is the same family of protocol as Linear's `lastSyncId`. It is not a vector clock, a CRDT state vector, or a per-user feed.

The authenticated `userId` answers whether the actor may access a workspace. The sync group identifies the feed. A personal-only app can use `workspace_id = "user:" || userId` in the same log table, but that is a special case for personal rows, not the copy-paste default.

An app server can use a table like this; Crucible does not assume this server schema:

```sql
CREATE TABLE changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  model TEXT NOT NULL,
  model_id TEXT NOT NULL,
  op TEXT NOT NULL,
  payload TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX changes_ws_id ON changes (workspace_id, id);
```

`AUTOINCREMENT` prevents SQLite from reusing deleted row IDs. The index must put `workspace_id` before `id`; do not scan `WHERE id > ?` across tenants. A pull is scoped to the authorized group:

```sql
SELECT id, model, model_id, op, payload, actor_id, created_at
FROM changes
WHERE workspace_id = ? AND id > ?
ORDER BY id
LIMIT 500;
```

Return `nextServerVersion` as the last returned row's `id`, or the incoming `since` value when the page is empty. IDs can have gaps because other workspaces share the global sequence. The server must return every change for this group through the page watermark in order.

Append the domain write and its change-log rows in the same server transaction. The mutation response's `serverVersion` must cover every side-effect row caused by that mutation. Deduplicate POST requests by `idempotencyKey`. An optional server `epoch` (generation) lets a client detect a restored or rebuilt log and replay from zero instead of treating an old cursor as caught up.

## Local storage and atomic writes

Keep domain data, the app-owned outbox, per-group cursor state, and optional acknowledgement barriers in the same SQLite database. Do not add `titlePending`, `completedPending`, or other per-field sync columns to domain tables.

A minimal app-owned schema can look like this:

```ts
export const syncOutbox = sqliteTable("sync_outbox", {
  id: text("id").primaryKey(),
  model: text("model").notNull(),
  modelId: text("model_id").notNull(),
  mutation: text("mutation").notNull(),
  payload: text("payload", { mode: "json" }).notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  createdAt: integer("created_at").notNull(),
});

export const syncState = sqliteTable("sync_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
```

Write a local domain row and its outbox entry in one transaction, then publish the same local subscription event the app already uses. Use one `createSingleWriterQueue()` per Worker and share it with local mutations and `createSyncRuntime`. Local GraphQL resolvers use `writerQueue.run(...)` and call `syncRuntime.poke()` after committing an outbox row. The runtime runs `apply` and `setCursor` through that queue together. Its `flush` callback receives `runWrite` so outbox reads and local acknowledgements use the same queue while network requests stay outside the queue.

The app should persist cursor versions under `serverVersion:<groupId>` (and epochs under `serverEpoch:<groupId>`). `createSyncCursorHelpers` implements those keys over an app-owned key/value adapter. Keep cursor writes ordered after applied rows. If the Worker stops after an apply but before the cursor update, the page can be replayed, so `apply` must be idempotent.

## Server mutation and pull endpoints

Apps implement these endpoints and enforce authz there:

```txt
POST /sync/mutations
  body: { idempotencyKey, mutation, payload, clientId }
  returns: { accepted: true, serverVersion, epoch? }

GET /sync/changes?workspaceId=<group>&since=<serverVersion>&epoch=<epoch>&limit=500
  returns: { changes: [...], nextServerVersion, epoch? }
```

The server-side mutation transaction applies the domain operation, appends all resulting change rows, and records the idempotency result. On a replayed `idempotencyKey`, return the original `serverVersion`. Pull authorization checks that the actor may read the requested workspace; `userId` is not the change-log partition key.

The ordered feed is total within the server log. Do not order by client timestamps or use `eq(todoChanges.userId, userId)` as the default feed filter. A user-scoped filter is appropriate only when those rows are intentionally personal-only and the user identity is the app's chosen group.

## Worker runtime

Construct the runtime inside the existing local GraphQL Worker and pass its handle to `serveLocalGraphQLWorker`. `start()` runs after Worker bootstrap. Apps remain responsible for opening their DB and supplying network and model-specific storage adapters:

```ts
const writerQueue = createSingleWriterQueue();
const cursor = createSyncCursorHelpers(syncStateAdapter);

export const syncRuntime = createSyncRuntime({
  groupId: () => activeWorkspaceId(),
  writerQueue,
  getCursor: cursor.getCursor,
  setCursor: cursor.setCursor,
  flush: async ({ runWrite }) => {
    const rows = await runWrite(() => readOutboxBatch(50));
    for (const row of rows) {
      const accepted = await postSyncMutation(row); // Includes idempotencyKey.
      // Store the mutation's acknowledgement barrier and remove this outbox
      // row atomically, using runWrite. Keep the barrier until its group cursor
      // reaches accepted.serverVersion.
      await runWrite(() => acknowledgeOutboxRow(row, accepted));
    }
  },
  pull: (since, epoch, limit) => pullWorkspaceChanges({
    workspaceId: activeWorkspaceId(),
    since,
    epoch,
    limit, // Crucible caps this at 500.
  }),
  // This callback is idempotent and preserves fields protected by a local
  // outbox row for the same model_id. Do not call writerQueue.run inside it:
  // Crucible already runs apply + setCursor in that queue.
  apply: (changes, { pendingByModelId }) =>
    applyRemoteChangesByType(changes, { pendingByModelId }),
  publishApplied: (changes) => publishLocalSubscriptionEvents(changes),
  status: {
    pendingCount: () => countOutboxRows(),
    hasPendingOutbox: (model, modelId) => outboxContains(model, modelId),
    getAcknowledgementBarrier: (model, modelId) => readAckBarrier(model, modelId),
  },
});

serveLocalGraphQLWorker({
  schema,
  bootstrap: openMigrateAndSeedLocalDatabase,
  context: async () => ({ db: await getLocalDb(), syncRuntime }),
  syncRuntime,
});
```

The runtime calls `flush`, then pulls up to 500 rows per request. It applies and advances the cursor in a bounded burst of at most eight pages, then yields so other Worker work can run. A full page starts another bounded burst. Pull-only is the default. Failures use exponential backoff; `offline` pauses work and `online` or `poke()` wakes it. Call `pause()` and `resume()` for app-controlled lifecycle changes.

Each tab owns a Worker, but only the Worker holding the app-scoped `navigator.locks` lock runs flush and pull. Followers still serve local GraphQL reads and writes and append to the shared outbox. The host page forwards online/offline events to the Worker. `idempotencyKey` makes repeated POSTs safe; it does not make two SQLite appliers safe, so the lock protects the shared file. Apps with multiple independent SQLite databases on one origin should provide separate `lockName` values for those databases.

The `flush` callback should leave an outbox row pending until the accepted `serverVersion` barrier has been persisted. Removing the outbox row before persisting its barrier creates a window where status can incorrectly appear synced. A successful flush alone does not mean caught up: a row is `PENDING_ACK` until its per-group cursor is at least the mutation's `serverVersion`.

When the server returns a different epoch, the runtime resets that group's cursor to zero and starts replaying. Apps can use `onEpochChange` to reset local projections or prepare a snapshot. The server must make the new generation replayable from zero or provide an app-owned snapshot bootstrap.

## Live push and the hold-back queue

Crucible exports `HoldBackQueue` and the `PushAdapter` interface, but does not create a WebSocket or SSE transport. Pass an adapter only when the app already has one. The runtime buffers push events and applies them only after a pull confirms complete feed coverage through that watermark.

This handles the race in Linear's sync model: a socket can deliver change `109` while a pull is still fetching `106–108`. The queue holds `109`; the pull applies its covered changes in order and advances only to `108`. A later pull fills the gap and advances through `109`. Since the log is shared across groups, numeric IDs can have gaps; the complete group-scoped pull page is what proves there are no unseen changes for that group before its watermark.

## Computed sync status

Use `syncRuntime.getSnapshot()` for runtime state (`isLeader`, `isOnline`, `pendingCount`, `lastError`). Use `syncRuntime.pendingByModelId(model, id)` and `syncRuntime.syncStatusFor(model, id, groupId?)` in app-owned local GraphQL resolvers. Supply `status` storage callbacks so these helpers read the app outbox and acknowledgement barriers. They return:

- `LOCAL_DRAFT` when the app's optional draft callback says it has not entered the outbox.
- `PENDING_FLUSH` while an outbox row exists for that `model_id`.
- `PENDING_ACK` after flush removes the outbox row but before the cursor reaches its barrier.
- `SYNCED` when neither the outbox nor an outstanding barrier applies.

When `serveLocalGraphQLWorker` receives a `syncRuntime`, it adds the computed `Query.syncRuntime` field and `SyncStatus` enum to the Worker schema. Add the matching declarations to the Relay compile-time schema as well. Apps can opt domain types into the enum, for example:

```graphql
enum SyncStatus { LOCAL_DRAFT PENDING_FLUSH PENDING_ACK SYNCED }

type CrucibleSyncRuntime {
  isLeader: Boolean!
  isOnline: Boolean!
  pendingCount: Int!
  lastError: String
}
extend type Query { syncRuntime: CrucibleSyncRuntime! }
extend type Todo { syncStatus: SyncStatus! }
```

The runtime's `syncRuntime` resolver reads `syncRuntime.getSnapshot()`, and `Todo.syncStatus` calls `syncRuntime.syncStatusFor("todo", todo.id, workspaceId)`. Apps can subscribe to `syncRuntime.subscribe(...)` and publish a local subscription event when they want Relay to refresh runtime-status selections. The helper reads sync metadata; it does not add pending columns to domain tables. Conflict rules and any optimistic field overlay remain app policy. In particular, `null` until pull and overlaying an outbox payload are both app choices.

Relay `useMutation`'s `isInFlight` only says that a local GraphQL operation is executing in this tab. A local-first mutation can commit SQLite and the outbox, then finish while its outbox row remains unsent for hours. It is per component and disappears on refresh, so use it for the save-button spinner only. It is not sync status and must not be used to decide whether a pull can overwrite local data.

Every `applyRemoteChange` implementation should be idempotent for an already-present local ID. Use the `pendingByModelId` helper passed to `apply` to check the app outbox. If a row remains for that `model_id`, do not let a stale pull overwrite its dirty local fields; preserve them or merge according to the app's conflict policy. After apply, `publishApplied` emits the same local subscription events as local mutations so active Relay subscriptions refresh.

## Conflict policy

The app chooses a policy for each domain type and implements it in `apply`. Common choices include last-write-wins for simple preferences, server-authoritative values for billing and permissions, and field-level merge for independent edits. CRDTs are appropriate only where the app needs multi-writer real-time editing and accepts their added complexity.

## What the relay-local example proves

`examples/relay-local` proves the browser-side local GraphQL path: Pothos and Drizzle resolvers run in a Worker, SQLite/OPFS persists rows across reloads, and subscriptions use Relay's normal subscription path. It still has no production outbox, auth, or sync server. Its existing app-graph sync panel is a browser status demo, not a replica protocol implementation. The example has no server feed; do not infer a per-user partition from it. Use a workspace or other explicit sync group by default.
