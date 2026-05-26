'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let db = null;

function init(userDataDir) {
  if (db) return db;
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
  const file = path.join(userDataDir, 'app.db');
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id           INTEGER PRIMARY KEY,
      summary      TEXT NOT NULL,
      client_name  TEXT,
      site_name    TEXT,
      status_name  TEXT,
      type_name    TEXT,
      is_project   INTEGER NOT NULL DEFAULT 0,
      last_synced  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id         INTEGER NOT NULL,
      ticket_summary    TEXT NOT NULL,
      start_at          TEXT NOT NULL,
      end_at            TEXT,
      note              TEXT NOT NULL DEFAULT '',
      synced_at         TEXT,
      synced_action_id  INTEGER,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_ticket ON sessions(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_running ON sessions(end_at) WHERE end_at IS NULL;
  `);

  // v0.4.0 migrations — add columns idempotently
  addColumnIfMissing(db, 'tickets', 'parent_project_id',      'INTEGER');
  addColumnIfMissing(db, 'tickets', 'parent_project_summary', 'TEXT');
  addColumnIfMissing(db, 'sessions', 'status_id',             'INTEGER');

  // v0.4.1 — capture the ticket's current status_id so the renderer can
  // resolve the status name from the loaded statuses list when Halo's
  // /Tickets response omits the status name string.
  addColumnIfMissing(db, 'tickets', 'status_id', 'INTEGER');
}

function addColumnIfMissing(db, table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some(c => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

// ----- settings -----

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value == null ? null : String(value));
}

// ----- tickets cache -----

function replaceTickets(tickets) {
  const now = new Date().toISOString();
  const tx = db.transaction((rows) => {
    db.prepare('DELETE FROM tickets').run();
    const stmt = db.prepare(`
      INSERT INTO tickets (
        id, summary, client_name, site_name, status_id, status_name, type_name,
        is_project, parent_project_id, parent_project_summary, last_synced
      ) VALUES (
        @id, @summary, @client_name, @site_name, @status_id, @status_name, @type_name,
        @is_project, @parent_project_id, @parent_project_summary, @last_synced
      )
    `);
    for (const t of rows) {
      stmt.run({
        id: t.id,
        summary: t.summary || '',
        client_name: t.client_name || '',
        site_name: t.site_name || '',
        status_id: t.status_id != null ? Number(t.status_id) : null,
        status_name: t.status_name || '',
        type_name: t.type_name || '',
        is_project: t.is_project ? 1 : 0,
        parent_project_id: t.parent_project_id || null,
        parent_project_summary: t.parent_project_summary || '',
        last_synced: now,
      });
    }
  });
  tx(tickets);
}

function listTickets() {
  return db.prepare(`
    SELECT id, summary, client_name, site_name, status_id, status_name, type_name,
           is_project, parent_project_id, parent_project_summary, last_synced
    FROM tickets
    ORDER BY is_project ASC, id DESC
  `).all().map(r => ({ ...r, is_project: !!r.is_project }));
}

// ----- sessions -----

function getRunningSession() {
  return db.prepare('SELECT * FROM sessions WHERE end_at IS NULL ORDER BY start_at DESC LIMIT 1').get() || null;
}

function startSession({ ticketId, ticketSummary, startAt }) {
  // Stop any currently running session first
  const running = getRunningSession();
  if (running) stopSession({ id: running.id, endAt: new Date().toISOString() });

  const info = db.prepare(`
    INSERT INTO sessions (ticket_id, ticket_summary, start_at, end_at, note)
    VALUES (?, ?, ?, NULL, '')
  `).run(ticketId, ticketSummary, startAt);
  return getSession(info.lastInsertRowid);
}

function stopSession({ id, endAt, note, statusId }) {
  const fields = ['end_at = @endAt', 'updated_at = datetime(\'now\')'];
  const params = { id, endAt };
  if (note !== undefined) {
    fields.push('note = @note');
    params.note = note;
  }
  if (statusId !== undefined) {
    fields.push('status_id = @statusId');
    params.statusId = statusId || null;
  }
  db.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = @id AND synced_at IS NULL`).run(params);
  return getSession(id);
}

function updateSession({ id, startAt, endAt, note, statusId, ticketId, ticketSummary }) {
  const fields = ['updated_at = datetime(\'now\')'];
  const params = { id };
  if (startAt !== undefined)      { fields.push('start_at = @startAt');           params.startAt = startAt; }
  if (endAt !== undefined)        { fields.push('end_at = @endAt');               params.endAt = endAt; }
  if (note !== undefined)         { fields.push('note = @note');                  params.note = note; }
  if (statusId !== undefined)     { fields.push('status_id = @statusId');         params.statusId = statusId || null; }
  if (ticketId !== undefined)     { fields.push('ticket_id = @ticketId');         params.ticketId = Number(ticketId) || 0; }
  if (ticketSummary !== undefined){ fields.push('ticket_summary = @ticketSummary'); params.ticketSummary = ticketSummary || ''; }
  db.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = @id AND synced_at IS NULL`).run(params);
  return getSession(id);
}

function deleteSession(id) {
  db.prepare('DELETE FROM sessions WHERE id = ? AND synced_at IS NULL').run(id);
}

function getSession(id) {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) || null;
}

function listSessions({ limit = 200, includeSynced = true } = {}) {
  const where = includeSynced ? '' : 'WHERE synced_at IS NULL';
  return db.prepare(`
    SELECT * FROM sessions
    ${where}
    ORDER BY start_at DESC
    LIMIT ?
  `).all(limit);
}

function listUnsyncedSessions() {
  return db.prepare(`
    SELECT * FROM sessions
    WHERE synced_at IS NULL AND end_at IS NOT NULL
    ORDER BY start_at ASC
  `).all();
}

/**
 * Insert a completed session that ended just now and started `minutes` ago.
 * Used by the global quick-log hotkeys (Ctrl+Alt+1/2/3). Does NOT touch any
 * running session — quick-logs are independent rows.
 *
 * Quick-logs are always created UNASSIGNED (ticket_id = 0). The user picks
 * the real ticket later via the Edit modal before pushing. This matches the
 * "Level 1 walks up for help" use case where Eric isn't the assigned agent
 * on the ticket and may not even know the ID at log time.
 */
function quickLogSession({ minutes }) {
  const end = new Date();
  const start = new Date(end.getTime() - Number(minutes) * 60_000);
  const info = db.prepare(`
    INSERT INTO sessions (ticket_id, ticket_summary, start_at, end_at, note)
    VALUES (?, ?, ?, ?, '')
  `).run(0, '(quick log — assign ticket before pushing)', start.toISOString(), end.toISOString());
  return getSession(info.lastInsertRowid);
}

function markSessionSynced({ id, actionId }) {
  db.prepare(`
    UPDATE sessions
    SET synced_at = datetime('now'), synced_action_id = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(actionId || null, id);
  return getSession(id);
}

// ----- backups -----

/**
 * Write a clean snapshot of the DB to `targetDir/app-YYYY-MM-DD.db`, then
 * prune to the most recent `keep` files. `VACUUM INTO` produces a single,
 * defragmented file with no WAL sidecars — safe to drop into a cloud-synced
 * folder. Skips if a snapshot for today already exists (idempotent).
 *
 * Returns { written: bool, path, pruned: number } so the caller can log it.
 * Errors bubble up — caller wraps in try/catch since this runs on startup
 * and a missing Documents folder shouldn't keep the app from launching.
 */
function runDailyBackup({ targetDir, keep = 14 } = {}) {
  if (!targetDir) throw new Error('targetDir is required');
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  const today = new Date();
  const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const filename = `app-${stamp}.db`;
  const full = path.join(targetDir, filename);

  let written = false;
  if (!fs.existsSync(full)) {
    // Write to a .tmp and rename so a partial file never appears as today's
    // backup. VACUUM INTO requires the target not to exist.
    const tmp = `${full}.tmp`;
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    db.prepare(`VACUUM INTO ?`).run(tmp);
    fs.renameSync(tmp, full);
    written = true;
  }

  // Prune — keep the `keep` newest app-*.db files, delete the rest.
  const files = fs.readdirSync(targetDir)
    .filter(f => /^app-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort()                  // lexicographic == chronological for ISO dates
    .reverse();              // newest first
  const toDelete = files.slice(keep);
  for (const f of toDelete) {
    try { fs.unlinkSync(path.join(targetDir, f)); } catch (_) { /* ignore */ }
  }

  return { written, path: full, pruned: toDelete.length };
}

// ----- aggregates for the daily/recent view -----

function dailyTotals({ days = 7 } = {}) {
  // start_at is stored as ISO 8601 UTC. Convert to the user's local calendar
  // before bucketing — otherwise an evening session (e.g. 8 PM EDT) ends up
  // in the *next* UTC day's bucket and shows up on the wrong card.
  return db.prepare(`
    SELECT
      substr(datetime(start_at, 'localtime'), 1, 10) AS day,
      COUNT(*) AS sessions,
      SUM(
        CASE WHEN end_at IS NULL THEN 0
        ELSE (julianday(end_at) - julianday(start_at)) * 24.0
        END
      ) AS hours
    FROM sessions
    GROUP BY day
    ORDER BY day DESC
    LIMIT ?
  `).all(days);
}

// Mon–Sun buckets, keyed by the Monday date. SQLite has no direct ISO-week
// function, so we shift each start_at backwards to the Monday of its week:
//   shift = (dow + 6) % 7   where dow is %w (0=Sun … 6=Sat)
// That gives Mon=0, Tue=1, … Sun=6, so subtracting it always lands on Monday.
function weeklyTotals({ weeks = 8 } = {}) {
  return db.prepare(`
    SELECT
      date(
        start_at,
        'localtime',
        '-' || ((CAST(strftime('%w', start_at, 'localtime') AS INTEGER) + 6) % 7) || ' days'
      ) AS week_start,
      COUNT(*) AS sessions,
      SUM(
        CASE WHEN end_at IS NULL THEN 0
        ELSE (julianday(end_at) - julianday(start_at)) * 24.0
        END
      ) AS hours
    FROM sessions
    GROUP BY week_start
    ORDER BY week_start DESC
    LIMIT ?
  `).all(weeks);
}

// Hours-by-client over the last N days. Joins sessions to the tickets cache
// to pick up client_name; sessions for tickets no longer in the cache (or
// unassigned quick-logs) bucket under "(unassigned)". Only completed sessions
// are counted.
function hoursByClient({ days = 30 } = {}) {
  const cutoff = `-${Number(days) || 30} days`;
  return db.prepare(`
    SELECT
      COALESCE(NULLIF(t.client_name, ''), '(unassigned)') AS client_name,
      COUNT(*) AS sessions,
      SUM((julianday(s.end_at) - julianday(s.start_at)) * 24.0) AS hours
    FROM sessions s
    LEFT JOIN tickets t ON t.id = s.ticket_id
    WHERE s.end_at IS NOT NULL
      AND date(s.start_at, 'localtime') >= date('now', 'localtime', ?)
    GROUP BY client_name
    ORDER BY hours DESC
  `).all(cutoff);
}

module.exports = {
  init,
  getSetting,
  setSetting,
  replaceTickets,
  listTickets,
  getRunningSession,
  startSession,
  stopSession,
  updateSession,
  deleteSession,
  getSession,
  listSessions,
  listUnsyncedSessions,
  markSessionSynced,
  dailyTotals,
  weeklyTotals,
  hoursByClient,
  quickLogSession,
  runDailyBackup,
};
