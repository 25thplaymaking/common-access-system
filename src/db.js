// One SQLite file holds everything the bot remembers. Uses Node's built-in
// SQLite (node:sqlite), so there is nothing native to compile.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT UNIQUE,
  channel_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  starts_at INTEGER NOT NULL,
  image_url TEXT NOT NULL DEFAULT '',
  max_participants INTEGER,
  ping_roles TEXT NOT NULL DEFAULT '[]',
  ping_special TEXT NOT NULL DEFAULT 'none',
  allow_tentative INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open',
  reminded INTEGER NOT NULL DEFAULT 0,
  started INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  host_name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rsvps (
  event_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  name TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  number INTEGER NOT NULL,
  channel_id TEXT UNIQUE,
  opener_id TEXT NOT NULL,
  opener_name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  answers TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open',
  claimed_by TEXT,
  outcome TEXT,
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  closed_by TEXT
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS joins (
  user_id TEXT NOT NULL,
  invite_code TEXT,
  source TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS joins_code ON joins (invite_code);
CREATE INDEX IF NOT EXISTS events_start ON events (status, starts_at);
`;

let db = null;

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

function get() {
  if (!db) throw new Error('Database is not open');
  return db;
}

function close() {
  if (db) db.close();
  db = null;
}

const now = () => Math.floor(Date.now() / 1000);

module.exports = { open, get, close, now };
