import sqlite3InitModule, { type Database, type SqlValue } from "@sqlite.org/sqlite-wasm";
import type { AsyncRemoteCallback } from "drizzle-orm/sqlite-proxy";

let dbPromise: Promise<Database> | null = null;

async function createDatabase(): Promise<Database> {
  const sqlite3 = await sqlite3InitModule();
  const db = sqlite3.oo1.OpfsDb
    ? new sqlite3.oo1.OpfsDb("/crucible-relay-local.sqlite3", "c")
    : new sqlite3.oo1.DB(":memory:");
  return db;
}

export function getSQLiteDatabase(): Promise<Database> {
  dbPromise ??= createDatabase();
  return dbPromise;
}

export const sqliteProxy: AsyncRemoteCallback = async (sql, params, method) => {
  const db = await getSQLiteDatabase();
  const bind = params as SqlValue[];

  if (method === "run") {
    db.exec({ sql, bind });
    return { rows: [] };
  }

  const rows: SqlValue[][] = [];
  db.exec({ sql, bind, rowMode: "array", resultRows: rows });

  if (method === "get") return { rows: (rows[0] ?? undefined) as never };
  return { rows };
};
