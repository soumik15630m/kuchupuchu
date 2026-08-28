import Database from "better-sqlite3";

let db: Database.Database | null = null;

/**
 * Single shared SQLite connection (§3, §4). WAL mode so the nightly-backup
 * `.sqlite` snapshot process (§11) can run concurrently without locking
 * writers out.
 */
export function getDb(): Database.Database {
  if (db) return db;
  const path = process.env.SQLITE_PATH ?? "/data/app.db";
  db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}
