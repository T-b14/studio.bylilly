const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');

// ── Schema ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS checkins (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT NOT NULL,         -- 'morning' | 'night'
    date        TEXT NOT NULL,         -- YYYY-MM-DD
    created_at  INTEGER NOT NULL,      -- unix ms
    data        TEXT NOT NULL          -- JSON blob
  );

  CREATE TABLE IF NOT EXISTS daily_plans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT NOT NULL UNIQUE,  -- YYYY-MM-DD (the day the plan is FOR)
    plan        TEXT NOT NULL,         -- JSON array of { time, activity }
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS weight_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT NOT NULL UNIQUE,  -- YYYY-MM-DD
    weight      REAL NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workout_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT NOT NULL UNIQUE,  -- YYYY-MM-DD
    verified    INTEGER NOT NULL DEFAULT 0,  -- 0 | 1 (screenshot verified)
    details     TEXT,                  -- JSON extracted from screenshot
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint    TEXT NOT NULL UNIQUE,
    keys        TEXT NOT NULL,         -- JSON { p256dh, auth }
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS escalation_state (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    date        TEXT NOT NULL,         -- YYYY-MM-DD
    level       INTEGER NOT NULL DEFAULT 0,  -- 0=none, 1=gentle, 2=firm, 3=blunt, 4=nuclear
    last_notif  INTEGER NOT NULL DEFAULT 0   -- unix ms
  );

  CREATE TABLE IF NOT EXISTS ai_digest (
    date        TEXT PRIMARY KEY,      -- YYYY-MM-DD
    articles    TEXT NOT NULL,         -- JSON array of {title, url, summary}
    overview    TEXT NOT NULL,         -- overall summary text
    created_at  INTEGER NOT NULL
  );
`);

// ── Helpers ───────────────────────────────────────────────────────────────────

const get = (key, fallback = null) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
};

const set = (key, value) => {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
};

const logCheckin = (type, date, data) => {
  db.prepare(
    'INSERT INTO checkins (type, date, created_at, data) VALUES (?, ?, ?, ?)'
  ).run(type, date, Date.now(), JSON.stringify(data));
};

const getCheckin = (type, date) => {
  const row = db.prepare(
    'SELECT * FROM checkins WHERE type = ? AND date = ? ORDER BY created_at DESC LIMIT 1'
  ).get(type, date);
  return row ? { ...row, data: JSON.parse(row.data) } : null;
};

const savePlan = (date, plan) => {
  db.prepare(
    'INSERT OR REPLACE INTO daily_plans (date, plan, created_at) VALUES (?, ?, ?)'
  ).run(date, JSON.stringify(plan), Date.now());
};

const getPlan = (date) => {
  const row = db.prepare('SELECT * FROM daily_plans WHERE date = ?').get(date);
  return row ? { ...row, plan: JSON.parse(row.plan) } : null;
};

const logWeight = (date, weight) => {
  db.prepare(
    'INSERT OR REPLACE INTO weight_log (date, weight, created_at) VALUES (?, ?, ?)'
  ).run(date, weight, Date.now());
};

const getRecentWeights = (n = 7) => {
  return db.prepare(
    'SELECT date, weight FROM weight_log ORDER BY date DESC LIMIT ?'
  ).all(n).reverse();
};

const logWorkout = (date, verified, details) => {
  db.prepare(
    'INSERT OR REPLACE INTO workout_log (date, verified, details, created_at) VALUES (?, ?, ?, ?)'
  ).run(date, verified ? 1 : 0, details ? JSON.stringify(details) : null, Date.now());
};

const getWorkout = (date) => {
  const row = db.prepare('SELECT * FROM workout_log WHERE date = ?').get(date);
  return row ? { ...row, details: row.details ? JSON.parse(row.details) : null } : null;
};

const getRecentWorkouts = (n = 14) => {
  return db.prepare(
    'SELECT * FROM workout_log ORDER BY date DESC LIMIT ?'
  ).all(n);
};

const saveSubscription = (endpoint, keys) => {
  db.prepare(
    'INSERT OR REPLACE INTO push_subscriptions (endpoint, keys, created_at) VALUES (?, ?, ?)'
  ).run(endpoint, JSON.stringify(keys), Date.now());
};

const getAllSubscriptions = () => {
  return db.prepare('SELECT * FROM push_subscriptions').all().map(r => ({
    endpoint: r.endpoint,
    keys: JSON.parse(r.keys)
  }));
};

const removeSubscription = (endpoint) => {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
};

const getEscalationState = (date) => {
  return db.prepare('SELECT * FROM escalation_state WHERE id = 1').get() || null;
};

const setEscalationState = (date, level, lastNotif) => {
  db.prepare(
    'INSERT OR REPLACE INTO escalation_state (id, date, level, last_notif) VALUES (1, ?, ?, ?)'
  ).run(date, level, lastNotif);
};

const getCheckinStreak = () => {
  // Count consecutive days with a night check-in
  const rows = db.prepare(
    "SELECT DISTINCT date FROM checkins WHERE type = 'night' ORDER BY date DESC LIMIT 30"
  ).all();
  if (!rows.length) return 0;
  let streak = 0;
  let cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  for (const row of rows) {
    const d = new Date(row.date + 'T00:00:00');
    const diff = Math.round((cursor - d) / 86400000);
    if (diff <= 1) { streak++; cursor = d; }
    else break;
  }
  return streak;
};

const getLiftStreak = () => {
  const rows = db.prepare(
    'SELECT date, verified FROM workout_log ORDER BY date DESC LIMIT 30'
  ).all();
  if (!rows.length) return { streak: 0, recentSkips: [] };
  let streak = 0;
  for (const row of rows) {
    if (row.verified) streak++;
    else break;
  }
  // Find skipped lift days in last 2 weeks
  const recentSkips = rows.filter(r => !r.verified).map(r => r.date);
  return { streak, recentSkips };
};

const getWeightTrend = () => {
  const weights = getRecentWeights(7);
  if (weights.length < 2) return null;
  const first = weights[0].weight;
  const last = weights[weights.length - 1].weight;
  const diff = last - first;
  return { diff: Math.round(diff * 10) / 10, direction: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat', entries: weights };
};

const saveDigest = (date, articles, overview) => {
  db.prepare(
    'INSERT OR REPLACE INTO ai_digest (date, articles, overview, created_at) VALUES (?, ?, ?, ?)'
  ).run(date, JSON.stringify(articles), overview, Date.now());
};

const getDigest = (date) => {
  const row = db.prepare('SELECT * FROM ai_digest WHERE date = ?').get(date);
  return row ? { articles: JSON.parse(row.articles), overview: row.overview } : null;
};

module.exports = {
  db,
  get, set,
  logCheckin, getCheckin,
  savePlan, getPlan,
  logWeight, getRecentWeights,
  logWorkout, getWorkout, getRecentWorkouts,
  saveSubscription, getAllSubscriptions, removeSubscription,
  getEscalationState, setEscalationState,
  getCheckinStreak, getLiftStreak, getWeightTrend,
  saveDigest, getDigest
};
