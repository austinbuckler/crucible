# Relay Local Example

This example shows Relay reading through Crucible's opt-in local GraphQL bridge.

```txt
Relay
  -> createLocalGraphQLFetch(localGraphQL)
  -> local GraphQL Worker
  -> Pothos schema
  -> Pothos Drizzle plugin
  -> Drizzle sqlite-proxy
  -> SQLite WASM OPFS database
```

The main thread only hosts React and Relay. The GraphQL executor, Pothos, Drizzle, and SQLite all run in `src/local/graphql-worker.ts`.

SQLite uses `@sqlite.org/sqlite-wasm`. In browsers where the OPFS VFS is available, the demo opens `/crucible-relay-local.sqlite3` in OPFS; otherwise it falls back to an in-memory database.

Run it:

```sh
bun install
bun run codegen
bun run dev
```

The opt-in happens in `src/app/crucible.config.ts`:

```ts
export const localGraphQL = {
  worker: () => new Worker(new URL("../local/graphql-worker.ts", import.meta.url), { type: "module" }),
};
```

Relay never knows about SQLite or sync. It sends a normal GraphQL POST, and Crucible routes that POST to the local worker because `localGraphQL` is exported.

This example proves the browser-side data path. It intentionally does not include a production sync server; see [`docs/local-first-sync.md`](../../docs/local-first-sync.md) for the recommended server contract, outbox shape, and Drizzle-style pseudo-code.

The page includes mutations so you can prove data is durable:

- Add a todo or toggle an existing todo.
- Click "Reload and read SQLite" or hard refresh the tab.
- The changed rows should still be present. Relay RecordSource persistence is disabled for this example, so surviving rows are coming from SQLite/OPFS rather than `localStorage`.

The storage panel reads `app { storage { persisted usage quota usageRatio } sync { status } }` from Crucible's Relay client graph. The button still uses a narrow browser action hook (`usePersistenceRequest()`), but the displayed state comes back through Relay. The SQLite database path is `/crucible-relay-local.sqlite3` when OPFS is available.

Subscriptions use real GraphQL subscription operations. `src/app/subscription-proof.tsx` runs `subscription subscriptionProof_TodoEventsSubscription { todoEvent { ... } }` through Relay. Crucible wires Relay's `Network.create(fetch, subscribe)` hook to `createLocalGraphQLSubscribe(localGraphQL)`, and worker mode calls GraphQL.js `subscribe()` inside the worker. In this example, the Pothos mutation resolvers publish typed `TodoEvent` payloads such as `TODO_CREATED` and `TODO_TOGGLED`; the subscription payload includes event metadata (`eventId`, `kind`, `message`, `emittedAt`, `sourceTab`) that is not part of the normal todo list query.

When `localGraphQL` is exported, Crucible's generated `main.tsx` awaits `prepareLocalGraphQL(localGraphQL)` before mounting React. In this example, the worker's `bootstrap` callback opens SQLite, applies Drizzle-generated migrations, and seeds the initial rows before the first route loads.

The splash lifecycle is intentionally explicit:

- `src/app/splash.tsx` renders immediately from generated HTML while the JS bundle loads.
- Generated `main.tsx` calls `await prepareLocalGraphQL(localGraphQL)` before `createRoot(...)`.
- `src/app/layout.tsx` calls `dismissSplashScreen()` after React has mounted.
