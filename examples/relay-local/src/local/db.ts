import { count } from "drizzle-orm";
import { drizzle, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import { applyMigrations } from "./migrations.ts";
import { dbRelations, dbSchema, todos } from "./schema.ts";
import { sqliteProxy } from "./sqlite.ts";

export type LocalDb = SqliteRemoteDatabase<typeof dbRelations>;

let db: LocalDb | null = null;
let ready: Promise<LocalDb> | null = null;

async function seed(db: LocalDb): Promise<void> {
  const [{ value = 0 } = {}] = await db.select({ value: count() }).from(todos);
  if (value > 0) return;

  await db.insert(todos).values([
    {
      id: "todo_1",
      title: "Render Relay from local SQLite",
      completed: true,
      updatedAt: "2026-07-14T09:00:00.000Z",
    },
    {
      id: "todo_2",
      title: "Run Pothos + Drizzle + SQLite in a Worker",
      completed: false,
      updatedAt: "2026-07-14T09:05:00.000Z",
    },
    {
      id: "todo_3",
      title: "Add mutation outbox and background pull",
      completed: false,
      updatedAt: "2026-07-14T09:10:00.000Z",
    },
  ]);
}

export async function getLocalDb(): Promise<LocalDb> {
  ready ??= (async () => {
    db ??= drizzle(sqliteProxy, {
      relations: dbRelations,
    });
    await applyMigrations();
    await seed(db);
    return db;
  })();
  return ready;
}
