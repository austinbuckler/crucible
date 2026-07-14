# App Graph

Crucible exposes framework/runtime state through Relay client resolvers under
`Query.app`. This keeps app reads on one path: Relay. Local GraphQL remains
optional; the app graph works for remote, local, and hybrid apps.

`preflight` emits `src/__crucible__/app-resolvers.ts` before `relay-compiler`
runs. Relay scans that source file and generates normal resolver artifacts, so
pages can query Crucible state alongside server/local schema fields.

```graphql
query ExampleQuery {
  app {
    storage {
      persisted
      usage
      quota
      usageRatio
    }
    sync {
      online
      status
      pendingMutations
      lastSyncedAt
      lastErrorMessage
      retryAt
      conflictCount
    }
  }
}
```

Relay resolver fields are nullable because Relay turns resolver errors into
`null`. Treat unknown browser capability state as `null`, not `false`.

## Storage

Storage fields are backed by `navigator.storage.persisted()` and
`navigator.storage.estimate()` where available.

```ts
const refreshStorage = Crucible.useStorageRefresh();
const requestPersistence = Crucible.usePersistenceRequest();
```

Use `refreshStorage()` after writes that may affect origin usage. Use
`requestPersistence()` from a user gesture, such as a button click. Both update
the Relay live resolver backing store; UI should read the latest values from the
graph.

## Sync

Crucible defines the sync status shape, but the sync engine remains app-owned.
Apps publish their own status source:

```ts
const cleanup = Crucible.configureSyncStatus({
  getSnapshot: () => ({
    status: "SYNCING",
    pendingMutations: outbox.count(),
    lastSyncedAt: sync.lastSuccessIso(),
  }),
  subscribe: (notify) => sync.subscribe(notify),
  flush: () => sync.flushOutbox(),
  retry: () => sync.retryNow(),
});
```

Actions stay narrow and imperative because they may involve user gestures,
network side effects, or app-owned orchestration:

```ts
const refreshSync = Crucible.useSyncRefresh();
const flushSync = Crucible.useSyncFlush();
const retrySync = Crucible.useSyncRetry();
```

The default sync state is intentionally conservative: online/offline comes from
the browser, status is `IDLE` while online and `OFFLINE` while offline, and all
counts/timestamps are empty until the app configures a source.

## Query APIs

If a query contains both app graph fields and server/local fields, use the normal
Relay APIs (`usePreloadedQuery`, route `export const query`, etc.). If a query
contains only client resolver fields, Relay currently requires `useClientQuery`.
