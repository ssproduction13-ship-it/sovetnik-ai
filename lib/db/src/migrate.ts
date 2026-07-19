import { sql } from "drizzle-orm";
import { getDb } from "./index";

/**
 * Idempotent schema bootstrap — runs CREATE TABLE IF NOT EXISTS on startup.
 * Safe to run on every deploy; never drops or alters existing data.
 */
export async function runMigrations(): Promise<void> {
  const db = getDb();

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS conversations (
      id          SERIAL PRIMARY KEY,
      title       TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS messages (
      id               SERIAL PRIMARY KEY,
      conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role             TEXT NOT NULL,
      content          TEXT NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS telegram_sessions (
      id                SERIAL PRIMARY KEY,
      telegram_chat_id  BIGINT NOT NULL UNIQUE,
      conversation_id   INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}
