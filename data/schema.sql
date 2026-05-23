-- SQLite schema reference
CREATE TABLE groups (
  chat_id TEXT PRIMARY KEY,
  title TEXT,
  is_premium INTEGER NOT NULL DEFAULT 0,
  language_mode TEXT NOT NULL DEFAULT 'auto',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE settings (
  chat_id TEXT PRIMARY KEY,
  battle_duration_sec INTEGER NOT NULL DEFAULT 30,
  join_button_text TEXT,
  winner_message_template TEXT,
  gif_enabled INTEGER NOT NULL DEFAULT 1,
  custom_effects_json TEXT,
  fixed_language TEXT,
  FOREIGN KEY(chat_id) REFERENCES groups(chat_id)
);

CREATE TABLE licenses (
  code TEXT PRIMARY KEY,
  is_used INTEGER NOT NULL DEFAULT 0,
  used_by_chat_id TEXT,
  used_by_user_id TEXT,
  activated_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE battles (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  winner_user_id TEXT,
  winner_username TEXT
);

CREATE TABLE players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  battle_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT,
  first_name TEXT,
  joined_at TEXT NOT NULL,
  UNIQUE(battle_id, user_id)
);

CREATE TABLE schedules (
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