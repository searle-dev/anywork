import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

let db: Database.Database;

export function getDb(): Database.Database {
  if (db) return db;

  const dbDir = process.env.DB_DIR || "/data";
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, "anywork.db");

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id           TEXT PRIMARY KEY,
      channel_type TEXT NOT NULL DEFAULT 'webchat',
      title        TEXT NOT NULL DEFAULT 'New Chat',
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      last_active  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_last_active ON sessions(last_active DESC);

    CREATE TABLE IF NOT EXISTS tasks (
      id                TEXT PRIMARY KEY,
      session_id        TEXT NOT NULL REFERENCES sessions(id),
      channel_type      TEXT NOT NULL DEFAULT 'webchat',
      channel_meta      TEXT DEFAULT '{}',
      status            TEXT NOT NULL DEFAULT 'pending',
      message           TEXT NOT NULL,
      skills            TEXT DEFAULT '[]',
      mcp_servers       TEXT DEFAULT '[]',
      result            TEXT,
      structured_output TEXT,
      error             TEXT,
      cost_usd          REAL,
      num_turns         INTEGER,
      duration_ms       INTEGER,
      worker_id         TEXT,
      push_notification TEXT,
      created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
      started_at        INTEGER,
      finished_at       INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

    CREATE TABLE IF NOT EXISTS task_logs (
      task_id    TEXT NOT NULL REFERENCES tasks(id),
      seq        INTEGER NOT NULL,
      type       TEXT NOT NULL,
      content    TEXT NOT NULL,
      metadata   TEXT DEFAULT '{}',
      timestamp  INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (task_id, seq)
    );

    CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs(task_id);
  `);

  // Migrate legacy schema: drop user_id dependency if old tables exist
  try {
    const hasUserIdCol = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'")
      .get() as { sql: string } | undefined;
    if (hasUserIdCol?.sql?.includes("user_id")) {
      // Legacy sessions table has user_id — recreate without it
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions_new (
          id           TEXT PRIMARY KEY,
          channel_type TEXT NOT NULL DEFAULT 'webchat',
          title        TEXT NOT NULL DEFAULT 'New Chat',
          created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
          last_active  INTEGER NOT NULL DEFAULT (unixepoch())
        );
        INSERT OR IGNORE INTO sessions_new (id, title, created_at, last_active)
          SELECT id, title,
            CAST(strftime('%s', created_at) AS INTEGER),
            CAST(strftime('%s', updated_at) AS INTEGER)
          FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_new RENAME TO sessions;
        CREATE INDEX IF NOT EXISTS idx_sessions_last_active ON sessions(last_active DESC);
      `);
      console.log("[DB] Migrated sessions table: removed user_id");
    }
  } catch {
    // Migration not needed or already done
  }

  // Drop legacy users table if it exists
  try {
    db.exec("DROP TABLE IF EXISTS users");
  } catch {
    // Ignore
  }

  return db;
}
