import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");

function runMigrations() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db.prepare("SELECT filename FROM _migrations").all().map((r: any) => r.filename)
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    console.log(`[migrate] applying ${file}`);
    db.exec(sql);
    db.prepare("INSERT INTO _migrations (filename) VALUES (?)").run(file);
  }

  seedAllowlist(db);
}

function seedAllowlist(db: ReturnType<typeof getDb>) {
  const seedList = (process.env.ADMIN_SEED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  // §1 hard cap — refuse to seed past 10 known members rather than silently
  // truncating, since that's a security-relevant constraint, not a UX one.
  if (seedList.length > 10) {
    throw new Error(
      `ADMIN_SEED_EMAILS has ${seedList.length} entries; §1 caps known members at 10.`
    );
  }

  const insert = db.prepare(
    "INSERT OR IGNORE INTO allowlist (email) VALUES (?)"
  );
  for (const email of seedList) {
    insert.run(email);
  }
  if (seedList.length) {
    console.log(`[migrate] allowlist seeded/verified for: ${seedList.join(", ")}`);
  }
}

runMigrations();
