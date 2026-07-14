import initialSchema from "../../drizzle/20260714052630_groovy_the_fallen/migration.sql?raw";
import { sqliteProxy } from "./sqlite.ts";

const migrations = [
  {
    id: "20260714052630_groovy_the_fallen",
    sql: initialSchema,
  },
] as const;

function splitMigration(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export async function applyMigrations(): Promise<void> {
  await sqliteProxy(
    `create table if not exists __crucible_local_migrations (
      id text primary key not null,
      applied_at text not null
    )`,
    [],
    "run",
  );

  for (const migration of migrations) {
    const existing = await sqliteProxy(
      "select id from __crucible_local_migrations where id = ? limit 1",
      [migration.id],
      "get",
    );
    if (existing.rows) continue;

    await sqliteProxy("begin", [], "run");
    try {
      for (const statement of splitMigration(migration.sql)) {
        await sqliteProxy(statement, [], "run");
      }
      await sqliteProxy(
        "insert into __crucible_local_migrations (id, applied_at) values (?, ?)",
        [migration.id, new Date().toISOString()],
        "run",
      );
      await sqliteProxy("commit", [], "run");
    } catch (err) {
      await sqliteProxy("rollback", [], "run");
      throw err;
    }
  }
}
