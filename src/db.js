const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const dbPath = process.env.DATABASE_PATH || "./data/rumble.db";
const resolved = path.resolve(dbPath);
fs.mkdirSync(path.dirname(resolved), { recursive: true });

const db = new Database(resolved);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS groups (
  chat_id TEXT PRIMARY KEY,
  title TEXT,
  is_premium INTEGER NOT NULL DEFAULT 0,
  language_mode TEXT NOT NULL DEFAULT 'auto',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  chat_id TEXT PRIMARY KEY,
  battle_duration_sec INTEGER NOT NULL DEFAULT 30,
  join_button_text TEXT,
  winner_message_template TEXT,
  gif_enabled INTEGER NOT NULL DEFAULT 1,
  custom_effects_json TEXT,
  fixed_language TEXT,
  FOREIGN KEY(chat_id) REFERENCES groups(chat_id)
);

CREATE TABLE IF NOT EXISTS licenses (
  code TEXT PRIMARY KEY,
  is_used INTEGER NOT NULL DEFAULT 0,
  used_by_chat_id TEXT,
  used_by_user_id TEXT,
  activated_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS battles (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  winner_user_id TEXT,
  winner_username TEXT
);

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  battle_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT,
  first_name TEXT,
  joined_at TEXT NOT NULL,
  UNIQUE(battle_id, user_id)
);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  type TEXT NOT NULL,
  time_hhmm TEXT,
  weekday INTEGER,
  run_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_schedules_chat_id ON schedules(chat_id);
CREATE INDEX IF NOT EXISTS idx_battles_chat_id ON battles(chat_id);

CREATE TABLE IF NOT EXISTS stripe_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

module.exports = db;
