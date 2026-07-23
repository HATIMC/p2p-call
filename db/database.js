'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Read TTL here so registerUser can clear expired slots before inserting.
// Mirrors the value read in server.js from the same env var.
const USER_TTL_MS = (() => {
  const s = parseInt(process.env.USER_TTL_SECONDS || '60', 10);
  return s > 0 ? s * 1000 : 0;
})();

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'db');
const DB_PATH = path.join(DATA_DIR, 'users.db');
const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;

let db;

function normalizeSessionToken(sessionToken) {
  if (typeof sessionToken !== 'string') return '';
  const token = sessionToken.trim();
  if (token === 'undefined' || token === 'null') return '';
  return SESSION_TOKEN_RE.test(token) ? token : '';
}

function getDb() {
  if (!db) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    initSchema(db);
  }
  return db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT UNIQUE NOT NULL,
      peer_id    TEXT NOT NULL,
      session_token TEXT,
      available INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL
    );
  `);

  // Migrate: registered_at → created_at (previous schema used registered_at)
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (cols.includes('registered_at') && !cols.includes('created_at')) {
    db.exec('ALTER TABLE users RENAME COLUMN registered_at TO created_at');
  }
  const migratedCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!migratedCols.includes('last_seen')) {
    db.exec('ALTER TABLE users ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0');
    db.prepare('UPDATE users SET last_seen = created_at WHERE last_seen = 0').run();
  }
  const tokenCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!tokenCols.includes('session_token')) {
    db.exec('ALTER TABLE users ADD COLUMN session_token TEXT');
  }
  const availableCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!availableCols.includes('available')) {
    db.exec('ALTER TABLE users ADD COLUMN available INTEGER NOT NULL DEFAULT 1');
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users (last_seen);
    CREATE INDEX IF NOT EXISTS idx_users_username_last_seen ON users (username, last_seen);
  `);
}

/**
 * Register or update a user's peerId.
 * Returns { ok: true } or { ok: false, error: string }
 */
function registerUser(username, peerId, sessionToken) {
  const name = (username || '').trim().toLowerCase();
  if (!name || name.length < 2 || name.length > 32) {
    return { ok: false, error: 'Username must be 2–32 characters.' };
  }
  if (!/^[a-z0-9_-]+$/.test(name)) {
    return { ok: false, error: 'Letters, numbers, _ and - only.' };
  }
  if (!peerId) {
    return { ok: false, error: 'peerId is required.' };
  }

  const db = getDb();
  const providedToken = normalizeSessionToken(sessionToken);
  const token = providedToken || crypto.randomBytes(24).toString('base64url');

  // If a record exists but has already expired, remove it first so the
  // slot is free and the INSERT below can succeed.
  const now = Date.now();
  if (USER_TTL_MS > 0) {
    const cutoff = now - USER_TTL_MS;
    db.prepare('DELETE FROM users WHERE username = ? AND last_seen < ?').run(name, cutoff);
  }

  // Pure INSERT — no upsert. If the name already exists (and is not expired)
  // the unique constraint fires and we return 'taken'.
  try {
    db.prepare('INSERT INTO users (username, peer_id, session_token, available, created_at, last_seen) VALUES (?, ?, ?, 1, ?, ?)')
      .run(name, peerId, token, now, now);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const existing = db.prepare('SELECT peer_id, session_token FROM users WHERE username = ?').get(name);
      if (existing?.peer_id === peerId && existing?.session_token && existing.session_token === providedToken) {
        db.prepare('UPDATE users SET last_seen = ?, available = 1 WHERE username = ?').run(now, name);
        return { ok: true, username: name, peerId, sessionToken: existing.session_token, refreshed: true };
      }
      return { ok: false, error: 'taken' };
    }
    throw err;
  }

  return { ok: true, username: name, peerId, sessionToken: token };
}

function validateSession(username, sessionToken) {
  const name = (username || '').trim().toLowerCase();
  const token = normalizeSessionToken(sessionToken);
  if (!name || !token) return false;
  const row = getDb()
    .prepare('SELECT session_token FROM users WHERE username = ?')
    .get(name);
  return !!row?.session_token && row.session_token === token;
}

/**
 * Returns { username, peerId } for a non-expired user, or null.
 * ttlMs = 0 means no expiry check (disabled).
 */
function getUser(username, ttlMs = 0) {
  const name = (username || '').trim().toLowerCase();
  const row = ttlMs > 0
    ? getDb()
      .prepare('SELECT username, peer_id FROM users WHERE username = ? AND available = 1 AND last_seen >= ?')
      .get(name, Date.now() - ttlMs)
    : getDb()
      .prepare('SELECT username, peer_id FROM users WHERE username = ? AND available = 1')
      .get(name);
  return row ? { username: row.username, peerId: row.peer_id } : null;
}

/**
 * Returns all non-expired users as [{ username, peerId }].
 * ttlMs = 0 means no expiry check (disabled).
 */
function getAllUsers(ttlMs = 0) {
  const rows = ttlMs > 0
    ? getDb()
      .prepare('SELECT username, peer_id FROM users WHERE available = 1 AND last_seen >= ? ORDER BY username')
      .all(Date.now() - ttlMs)
    : getDb()
      .prepare('SELECT username, peer_id FROM users WHERE available = 1 ORDER BY username')
      .all();
  return rows
    .map(r => ({ username: r.username, peerId: r.peer_id }));
}

function countAvailableUsers(ttlMs = 0) {
  return ttlMs > 0
    ? getDb()
      .prepare('SELECT COUNT(*) AS count FROM users WHERE available = 1 AND last_seen >= ?')
      .get(Date.now() - ttlMs).count
    : getDb()
      .prepare('SELECT COUNT(*) AS count FROM users WHERE available = 1')
      .get().count;
}

function evictOldestAvailableUsers(count = 1) {
  if (!count || count <= 0) return 0;
  const result = getDb()
    .prepare(`
      DELETE FROM users
      WHERE id IN (
        SELECT id FROM users
        WHERE available = 1
        ORDER BY last_seen ASC, created_at ASC
        LIMIT ?
      )
    `)
    .run(count);
  return result.changes;
}

function touchUser(username) {
  const name = (username || '').trim().toLowerCase();
  if (!name) return 0;
  const result = getDb()
    .prepare('UPDATE users SET last_seen = ? WHERE username = ?')
    .run(Date.now(), name);
  return result.changes;
}

/**
 * Delete all users whose created_at is older than ttlMs ago.
 * Returns the count of deleted rows.
 */
function deleteExpiredUsers(ttlMs, limit = 500) {
  if (!ttlMs || ttlMs <= 0) return 0;
  const cutoff = Date.now() - ttlMs;
  const result = getDb()
    .prepare(`
      DELETE FROM users
      WHERE id IN (
        SELECT id FROM users
        WHERE last_seen < ?
        ORDER BY last_seen
        LIMIT ?
      )
    `)
    .run(cutoff, limit);
  return result.changes;
}

/** Delete a single user by username. Used when they enter a call. */
function deleteUser(username) {
  getDb()
    .prepare('DELETE FROM users WHERE username = ?')
    .run((username || '').trim().toLowerCase());
}

function setUserAvailable(username, available) {
  const result = getDb()
    .prepare('UPDATE users SET available = ?, last_seen = ? WHERE username = ?')
    .run(available ? 1 : 0, Date.now(), (username || '').trim().toLowerCase());
  return result.changes;
}

function deleteAllUsers() {
  const result = getDb().prepare('DELETE FROM users').run();
  return result.changes;
}

module.exports = { registerUser, validateSession, getUser, getAllUsers, countAvailableUsers, evictOldestAvailableUsers, touchUser, deleteExpiredUsers, deleteUser, setUserAvailable, deleteAllUsers };
