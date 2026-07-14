# Local-first sync

Crucible's local GraphQL support is a client-side seam, not a server framework. Relay still sends normal GraphQL operations. When an app exports `localGraphQL`, Crucible routes those operations to a local executor, usually in a Worker, where your schema can read and write a browser SQLite database.

The server-side story stays application-owned:

- Crucible owns route preloading, Relay environment wiring, local GraphQL fetch/subscribe adapters, and Worker boot.
- Your app owns domain tables, conflict rules, auth, server mutations, and change feeds.
- Relay should not know whether data came from a remote GraphQL server, local SQLite, or synced state.

When `localGraphQL` is present, generated boot code disables Relay RecordSource persistence by default. Keep it that way unless you have a specific reason to persist Relay's normalized cache separately from SQLite.

## Recommended shape

Use a single local SQLite database for domain data and the sync outbox. That lets a mutation update local rows and append the outbound sync event in one transaction.

```txt
React + Relay
  -> local GraphQL fetch/subscribe
  -> Worker schema resolvers
  -> SQLite transaction
       -> update app tables
       -> append sync_outbox row
  -> background sync loop flushes outbox to your server
```

Keep SQLite writes behind one writer queue in the Worker. Browser SQLite implementations are usually single-writer; a queue gives you deterministic transaction ordering without inventing a second durable store.

## Client tables

A minimal Drizzle-shaped schema looks like this:

```ts
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const todos = sqliteTable("todos", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  completed: integer("completed", { mode: "boolean" }).notNull(),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at"),
});

export const syncOutbox = sqliteTable("sync_outbox", {
  id: text("id").primaryKey(),
  mutation: text("mutation").notNull(),
  payload: text("payload", { mode: "json" }).notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  createdAt: text("created_at").notNull(),
  attempts: integer("attempts").notNull().default(0),
});

export const syncState = sqliteTable("sync_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
```

Write local data and outbox rows atomically. If your browser SQLite adapter does not support Drizzle's `transaction(...)` API, issue explicit SQL such as `BEGIN IMMEDIATE`, `COMMIT`, and `ROLLBACK` through the adapter.

```ts
async function createTodo(input: { title: string }) {
  return writerQueue.run(async () => {
    await db.run(sql`BEGIN IMMEDIATE`);
    try {
      const todo = {
        id: crypto.randomUUID(),
        title: input.title,
        completed: false,
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      };

      await db.insert(todos).values(todo);
      await db.insert(syncOutbox).values({
        id: crypto.randomUUID(),
        mutation: "todo.create",
        payload: todo,
        idempotencyKey: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      });

      await db.run(sql`COMMIT`);
      publishTodoEvent(todo);
      return todo;
    } catch (error) {
      await db.run(sql`ROLLBACK`);
      throw error;
    }
  });
}
```

## Server endpoints

The server can be GraphQL or plain HTTP. The important contracts are idempotent mutation acceptance and an ordered changes feed.

```txt
POST /sync/mutations
  body: { idempotencyKey, mutation, payload, clientId }
  returns: { accepted: true, serverVersion }

GET /sync/changes?since=<serverVersion>
  returns: { changes: [...], nextServerVersion }
```

Server mutation handling should dedupe by `idempotencyKey` before applying domain writes.

```ts
async function acceptMutation(req: Request, userId: string) {
  const input = await req.json();

  return db.transaction(async (tx) => {
    const existing = await tx.query.receivedMutations.findFirst({
      where: eq(receivedMutations.idempotencyKey, input.idempotencyKey),
    });
    if (existing) return { accepted: true, serverVersion: existing.serverVersion };

    const serverVersion = await applyDomainMutation(tx, userId, input);
    await tx.insert(receivedMutations).values({
      idempotencyKey: input.idempotencyKey,
      userId,
      serverVersion,
      receivedAt: new Date().toISOString(),
    });

    return { accepted: true, serverVersion };
  });
}
```

The changes endpoint should return changes in stable server order. Use a monotonic sequence, commit timestamp plus tie-breaker, or database log table. Do not page by client timestamps.

```ts
async function changesSince(userId: string, since: number) {
  const changes = await db.query.todoChanges.findMany({
    where: and(eq(todoChanges.userId, userId), gt(todoChanges.version, since)),
    orderBy: asc(todoChanges.version),
    limit: 500,
  });

  return {
    changes,
    nextServerVersion: changes.at(-1)?.version ?? since,
  };
}
```

## Client sync loop

Run sync outside Relay. Relay reads local GraphQL. The sync loop moves data between local SQLite and your server, then publishes local subscription events so active Relay subscriptions can update.

```ts
async function syncOnce() {
  await flushOutbox();
  await pullChanges();
}

async function flushOutbox() {
  const rows = await db.select().from(syncOutbox).orderBy(syncOutbox.createdAt).limit(50);
  for (const row of rows) {
    const response = await fetch("/sync/mutations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: row.idempotencyKey,
        mutation: row.mutation,
        payload: row.payload,
        clientId,
      }),
    });

    if (!response.ok) break;
    await db.delete(syncOutbox).where(eq(syncOutbox.id, row.id));
  }
}

async function pullChanges() {
  const since = await readSyncState("serverVersion", "0");
  const response = await fetch(`/sync/changes?since=${encodeURIComponent(since)}`);
  if (!response.ok) return;

  const { changes, nextServerVersion } = await response.json();
  await writerQueue.run(async () => {
    await db.run(sql`BEGIN IMMEDIATE`);
    try {
      for (const change of changes) await applyRemoteChange(change);
      await writeSyncState("serverVersion", String(nextServerVersion));
      await db.run(sql`COMMIT`);
    } catch (error) {
      await db.run(sql`ROLLBACK`);
      throw error;
    }
  });
}
```

## Conflict policy

Pick one policy per domain type and make it explicit. Common choices:

- Last-write-wins for simple preferences and drafts.
- Server-authoritative for billing, permissions, and inventory.
- Field-level merge for collaborative records where independent fields can change safely.
- CRDTs only where multi-writer real-time editing justifies the complexity.

The client local schema should mirror that policy. For server-authoritative fields, optimistic local values should be marked pending and replaced by pulled server changes.

## What the relay-local example proves

`examples/relay-local` proves the browser-side half:

- local GraphQL executes in a Worker.
- Pothos + Drizzle can back Relay queries and mutations.
- SQLite/OPFS survives reloads while Relay RecordSource persistence is disabled.
- GraphQL subscriptions work through Relay's normal subscription path.

It intentionally does not ship a production sync server. Add one using the contracts above when your app needs cross-device sync, auth, and conflict resolution.
