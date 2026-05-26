'use strict';

const path = require('path');
const { ipcMain, app, BrowserWindow, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const { HaloClient } = require('./halo-client');
const { MockHaloClient, MOCK_AGENT_ID } = require('./mock-halo-client');

const RELEASES_URL = 'https://github.com/nyr3188/halopsa-time-tracker/releases';

let _db = null;
let _creds = null;
let _client = null;
let _nudge = null;
let _statusesCache = null;
let _onSessionChanged = null;
let _onPrefsChanged = null;
let _getMainWindow = null;

// Sessions currently mid-push to Halo. Guards against the user clicking
// "Push" twice (or Push + Push-all) and creating duplicate actions in Halo.
const _pushingIds = new Set();

// ---- preferences ----

const DEFAULT_HOTKEYS = Object.freeze({
  showApp:    'Control+Alt+T',
  quickLog1:  'Control+Alt+1',
  quickLog2:  'Control+Alt+2',
  quickLog3:  'Control+Alt+3',
});

const PREFS_DEFAULTS = Object.freeze({
  idleAutoPauseEnabled: true,
  idleThresholdMinutes: 5,
  nudgeEnabled: true,
  nudgeIntervalMinutes: 30,
  workHoursStart: '09:00',
  workHoursEnd: '17:00',
  // Comma-separated weekday numbers: 0=Sun, 1=Mon, ... 6=Sat. Default Mon–Fri.
  workDays: '1,2,3,4,5',
  // Three quick-log durations, in minutes. The renderer renders one button
  // per entry; the main process registers one global hotkey per entry.
  quickLogMinutes: [5, 10, 15],
  // Accelerator strings (Electron format). Blank = unregistered.
  hotkeys: { ...DEFAULT_HOTKEYS },
});

function readPrefs() {
  const raw = _db.getSetting('prefs');
  if (!raw) return clonePrefs(PREFS_DEFAULTS);
  try {
    const parsed = JSON.parse(raw);
    const merged = { ...PREFS_DEFAULTS, ...parsed };
    // Nested objects/arrays need their own merge so older configs that
    // pre-date a new field still pick up its default.
    merged.hotkeys = { ...DEFAULT_HOTKEYS, ...(parsed.hotkeys || {}) };
    merged.quickLogMinutes = sanitizeQuickLogMinutes(
      parsed.quickLogMinutes || PREFS_DEFAULTS.quickLogMinutes
    );
    return merged;
  } catch (_) {
    return clonePrefs(PREFS_DEFAULTS);
  }
}

function clonePrefs(src) {
  return {
    ...src,
    hotkeys: { ...src.hotkeys },
    quickLogMinutes: [...src.quickLogMinutes],
  };
}

// Three positive integers between 1 and 480 minutes. Anything else falls
// back to the corresponding default — keeps a malformed save from breaking
// the quick-log bar.
function sanitizeQuickLogMinutes(input) {
  const defaults = PREFS_DEFAULTS.quickLogMinutes;
  const arr = Array.isArray(input) ? input : [];
  return [0, 1, 2].map(i => {
    const n = Math.round(Number(arr[i]));
    return Number.isFinite(n) && n >= 1 && n <= 480 ? n : defaults[i];
  });
}

// Accelerator strings are validated structurally — must contain at least one
// modifier (Ctrl/Alt/Shift/Meta/Cmd/Super) and exactly one non-modifier key.
// Returns the trimmed string if valid, null otherwise.
function sanitizeAccelerator(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parts = trimmed.split('+').map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const mods = new Set(['Control', 'Ctrl', 'CommandOrControl', 'CmdOrCtrl', 'Alt', 'Option', 'AltGr', 'Shift', 'Super', 'Meta', 'Command', 'Cmd']);
  const modifierCount = parts.filter(p => mods.has(p)).length;
  const keyCount = parts.length - modifierCount;
  if (modifierCount < 1 || keyCount !== 1) return null;
  return parts.join('+');
}

function writePrefs(partial) {
  const next = { ...readPrefs(), ...(partial || {}) };
  // Light validation — clamp numerics into sane ranges
  next.idleThresholdMinutes = clamp(Number(next.idleThresholdMinutes) || 5, 1, 240);
  next.nudgeIntervalMinutes = clamp(Number(next.nudgeIntervalMinutes) || 30, 5, 240);
  next.idleAutoPauseEnabled = !!next.idleAutoPauseEnabled;
  next.nudgeEnabled = !!next.nudgeEnabled;
  next.quickLogMinutes = sanitizeQuickLogMinutes(next.quickLogMinutes);
  const incoming = (partial && partial.hotkeys) || {};
  const merged = { ...DEFAULT_HOTKEYS, ...(next.hotkeys || {}) };
  for (const key of Object.keys(DEFAULT_HOTKEYS)) {
    if (incoming[key] !== undefined) {
      // Empty string = explicitly disabled. Anything else must validate.
      const raw = incoming[key];
      if (raw === '' || raw === null) merged[key] = '';
      else merged[key] = sanitizeAccelerator(raw) || merged[key];
    }
  }
  next.hotkeys = merged;
  _db.setSetting('prefs', JSON.stringify(next));
  // Let main re-register globalShortcuts with the new accelerators/durations.
  if (typeof _onPrefsChanged === 'function') {
    try { _onPrefsChanged(next); } catch (_) { /* ignore — save still succeeded */ }
  }
  return next;
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

function broadcastSessionChanged() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('session:changed');
  }
  // Let the main process refresh its tray menu/tooltip in response.
  if (typeof _onSessionChanged === 'function') {
    try { _onSessionChanged(); } catch (_) { /* never let tray refresh kill the broadcast */ }
  }
}

/**
 * Build a HaloClient (or MockHaloClient in demo mode) from the stored
 * credentials. Throws if nothing has been configured yet.
 */
function buildClient() {
  if (_client) return _client;
  const c = _creds.load();
  if (!c) throw new Error('Halo credentials are not configured.');
  if (c.demoMode) {
    _client = new MockHaloClient();
    return _client;
  }
  if (!c.baseUrl || !c.clientId || !c.clientSecret) {
    throw new Error('Halo credentials are not configured.');
  }
  _client = new HaloClient({
    baseUrl: c.baseUrl,
    clientId: c.clientId,
    clientSecret: c.clientSecret,
    scope: c.scope || 'all',
  });
  return _client;
}

function resetClient() { _client = null; _statusesCache = null; }

// --- helpers ---

function ok(data)   { return { ok: true, data }; }
function fail(err)  { return { ok: false, error: err && err.message ? err.message : String(err) }; }

function hoursBetween(startIso, endIso) {
  const start = new Date(startIso).getTime();
  const end   = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  // Round to nearest minute, expressed as decimal hours
  const minutes = Math.round((end - start) / 60_000);
  return Math.round((minutes / 60) * 10000) / 10000;
}

function registerIpc({ db, creds, nudge, onSessionChanged, onPrefsChanged, getMainWindow }) {
  _db = db;
  _creds = creds;
  _nudge = nudge || null;
  _onSessionChanged = typeof onSessionChanged === 'function' ? onSessionChanged : null;
  _onPrefsChanged = typeof onPrefsChanged === 'function' ? onPrefsChanged : null;
  _getMainWindow = typeof getMainWindow === 'function' ? getMainWindow : null;

  // ---- status / settings ----

  ipcMain.handle('app:status', async () => {
    const stored = _creds.load();
    const demoMode = !!stored?.demoMode;
    return ok({
      configured: !!stored,
      demoMode,
      baseUrl: demoMode ? 'Demo Mode (no Halo connection)' : (stored?.baseUrl || ''),
      email: stored?.email || '',
      agentId: stored?.agentId || null,
      includeProjects: _db.getSetting('includeProjects') !== '0',
      encryptionAvailable: _creds.available(),
    });
  });

  ipcMain.handle('demo:enable', async () => {
    try {
      _creds.save({
        demoMode: true,
        email: 'demo@local',
        agentId: MOCK_AGENT_ID,
      });
      _db.setSetting('includeProjects', '1');
      resetClient();
      return ok({ demoMode: true, agentId: MOCK_AGENT_ID });
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('creds:save', async (_evt, payload) => {
    try {
      const baseUrl = (payload?.baseUrl || '').trim().replace(/\/+$/, '');
      const clientId = (payload?.clientId || '').trim();
      const clientSecret = (payload?.clientSecret || '').trim();
      const email = (payload?.email || '').trim();
      const scope = (payload?.scope || 'all').trim() || 'all';
      const includeProjects = payload?.includeProjects !== false;

      if (!baseUrl || !clientId || !clientSecret || !email) {
        throw new Error('All fields (Halo URL, Client ID, Client Secret, Email) are required.');
      }
      if (!/^https?:\/\//i.test(baseUrl)) {
        throw new Error('Halo URL must start with https:// or http://');
      }

      // Test connection + resolve agent ID before persisting
      const client = new HaloClient({ baseUrl, clientId, clientSecret, scope });
      await client.testConnection();
      const agentId = await client.findAgentIdByEmail(email);
      if (!agentId) {
        throw new Error(`Connected to Halo, but could not find an agent with email ${email}.`);
      }

      _creds.save({ baseUrl, clientId, clientSecret, scope, email, agentId });
      _db.setSetting('includeProjects', includeProjects ? '1' : '0');
      resetClient();
      return ok({ agentId });
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('creds:clear', async () => {
    _creds.clear();
    resetClient();
    return ok(true);
  });

  ipcMain.handle('halo:test', async () => {
    try {
      const client = buildClient();
      await client.testConnection();
      return ok(true);
    } catch (err) {
      return fail(err);
    }
  });

  // ---- tickets ----

  ipcMain.handle('tickets:refresh', async () => {
    try {
      const client = buildClient();
      const stored = _creds.load();
      if (!stored?.agentId) throw new Error('Agent ID is not set; reconnect in settings.');
      const includeProjects = _db.getSetting('includeProjects') !== '0';
      const tickets = await client.listMyTickets({
        agentId: stored.agentId,
        includeProjects,
      });
      _db.replaceTickets(tickets);
      return ok({ count: tickets.length, tickets: _db.listTickets() });
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('tickets:list', async () => {
    try {
      return ok(_db.listTickets());
    } catch (err) { return fail(err); }
  });

  // ---- statuses ----

  ipcMain.handle('statuses:list', async () => {
    try {
      if (_statusesCache) return ok(_statusesCache);
      const client = buildClient();
      const statuses = await client.getStatuses();
      // Hide closed statuses from the in-app picker — you can't push time
      // and mark closed in one step in any sensible workflow.
      _statusesCache = statuses.filter(s => !s.isClosed);
      return ok(_statusesCache);
    } catch (err) { return fail(err); }
  });

  // ---- sessions ----

  ipcMain.handle('sessions:start', async (_evt, payload) => {
    try {
      const ticketId = Number(payload?.ticketId);
      if (!ticketId) throw new Error('ticketId is required');
      // Look up summary from cache; if missing, accept whatever was passed
      const tickets = _db.listTickets();
      const t = tickets.find(x => x.id === ticketId);
      const summary = t?.summary || payload?.ticketSummary || `#${ticketId}`;
      const startAt = payload?.startAt || new Date().toISOString();
      const session = _db.startSession({ ticketId, ticketSummary: summary, startAt });
      if (_nudge) _nudge.markActivity();
      broadcastSessionChanged();
      return ok(session);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('sessions:stop', async (_evt, payload) => {
    try {
      const id = Number(payload?.id);
      if (!id) throw new Error('id is required');
      const endAt = payload?.endAt || new Date().toISOString();
      const session = _db.stopSession({
        id,
        endAt,
        note: payload?.note,
        statusId: payload?.statusId,
      });
      return ok(session);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('sessions:update', async (_evt, payload) => {
    try {
      const id = Number(payload?.id);
      if (!id) throw new Error('id is required');
      const session = _db.updateSession({
        id,
        startAt:       payload?.startAt,
        endAt:         payload?.endAt,
        note:          payload?.note,
        statusId:      payload?.statusId,
        ticketId:      payload?.ticketId,
        ticketSummary: payload?.ticketSummary,
      });
      return ok(session);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('sessions:delete', async (_evt, id) => {
    try {
      _db.deleteSession(Number(id));
      return ok(true);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('sessions:list', async (_evt, payload) => {
    try {
      return ok(_db.listSessions(payload || {}));
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('sessions:running', async () => {
    try { return ok(_db.getRunningSession()); }
    catch (err) { return fail(err); }
  });

  ipcMain.handle('sessions:push', async (_evt, id) => {
    const sessionId = Number(id);
    if (!sessionId) return fail(new Error('id is required'));
    if (_pushingIds.has(sessionId)) {
      return fail(new Error('This session is already being pushed — please wait.'));
    }
    _pushingIds.add(sessionId);
    try {
      const session = _db.getSession(sessionId);
      if (!session) throw new Error('Session not found');
      if (!session.end_at) throw new Error('Session is still running; stop it first.');
      if (session.synced_at) return ok({ alreadySynced: true, session });
      if (!session.ticket_id) {
        throw new Error('This session has no ticket assigned. Click Edit and enter a ticket number first.');
      }

      const client = buildClient();
      const hours = hoursBetween(session.start_at, session.end_at);
      if (hours <= 0) throw new Error('Session has zero duration; nothing to push.');

      const { action, statusWarning } = await client.postTicketAction({
        ticketId: session.ticket_id,
        note: session.note || '(no note)',
        timeTakenHours: hours,
        occurredAt: new Date(session.start_at),
        isPrivate: true,
        statusId: session.status_id || null,
      });
      const actionId = action?.id || action?.actionid || null;
      const updated = _db.markSessionSynced({ id: session.id, actionId });
      return ok({ session: updated, actionId, hours, statusWarning });
    } catch (err) {
      return fail(err);
    } finally {
      _pushingIds.delete(sessionId);
    }
  });

  ipcMain.handle('sessions:pushAll', async () => {
    try {
      const pending = _db.listUnsyncedSessions();
      const client = buildClient();
      const results = [];
      for (const session of pending) {
        if (_pushingIds.has(session.id)) {
          results.push({ id: session.id, ok: false, error: 'Already being pushed' });
          continue;
        }
        if (!session.ticket_id) {
          results.push({ id: session.id, ok: false, error: 'No ticket assigned — edit the session first' });
          continue;
        }
        _pushingIds.add(session.id);
        try {
          const hours = hoursBetween(session.start_at, session.end_at);
          if (hours <= 0) {
            results.push({ id: session.id, ok: false, error: 'Zero duration' });
            continue;
          }
          const { action, statusWarning } = await client.postTicketAction({
            ticketId: session.ticket_id,
            note: session.note || '(no note)',
            timeTakenHours: hours,
            occurredAt: new Date(session.start_at),
            isPrivate: true,
            statusId: session.status_id || null,
          });
          const actionId = action?.id || action?.actionid || null;
          _db.markSessionSynced({ id: session.id, actionId });
          results.push({ id: session.id, ok: true, actionId, hours, statusWarning });
        } catch (err) {
          results.push({ id: session.id, ok: false, error: err.message });
        } finally {
          _pushingIds.delete(session.id);
        }
      }
      return ok(results);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('sessions:quickLog', async (_evt, payload) => {
    try {
      const minutes = Number(payload?.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('minutes must be a positive number');
      // Quick-logs are always unassigned — user picks the real ticket later
      // via the Edit modal. See db.quickLogSession for the rationale.
      const session = _db.quickLogSession({ minutes });
      broadcastSessionChanged();
      return ok({ session, minutes });
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('sessions:dailyTotals', async (_evt, payload) => {
    try {
      return ok(_db.dailyTotals(payload || {}));
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('sessions:weeklyTotals', async (_evt, payload) => {
    try {
      return ok(_db.weeklyTotals(payload || {}));
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('sessions:hoursByClient', async (_evt, payload) => {
    try {
      return ok(_db.hoursByClient(payload || {}));
    } catch (err) { return fail(err); }
  });

  // ---- preferences ----

  ipcMain.handle('prefs:get', async () => {
    try { return ok(readPrefs()); }
    catch (err) { return fail(err); }
  });

  ipcMain.handle('prefs:save', async (_evt, payload) => {
    try { return ok(writePrefs(payload)); }
    catch (err) { return fail(err); }
  });

  // ---- launch at login (Windows / macOS) ----

  // The args / path passed to getLoginItemSettings must match what was passed
  // to setLoginItemSettings — otherwise Electron compares against an empty
  // args array and won't recognise the registry entry we wrote (Windows),
  // which makes openAtLogin read back as false even when the entry exists.
  const AUTOLAUNCH_OPTIONS = {
    path: process.execPath,
    args: ['--hidden'],
  };

  ipcMain.handle('autolaunch:get', async () => {
    try {
      const settings = app.getLoginItemSettings(AUTOLAUNCH_OPTIONS);
      return ok({ enabled: !!settings.openAtLogin });
    } catch (err) {
      return fail(err);
    }
  });

  // ---- nudge popup ----

  ipcMain.handle('nudge:context', async () => {
    try {
      if (!_nudge) return ok(null);
      return ok(_nudge.getPopupContext());
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('nudge:snooze', async (_evt, value) => {
    try {
      if (_nudge) _nudge.snooze(value);
      return ok(true);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('nudge:started', async () => {
    try {
      if (_nudge) {
        _nudge.markActivity();
        _nudge.closePopup();
      }
      return ok(true);
    } catch (err) { return fail(err); }
  });

  // ---- about / updates ----

  ipcMain.handle('app:info', async () => {
    try {
      return ok({
        version: app.getVersion(),
        isPackaged: app.isPackaged,
        logPath: path.join(app.getPath('userData'), 'logs', 'main.log'),
        backupDir: path.join(app.getPath('documents'), 'HaloPSA Time Tracker', 'backups'),
        releasesUrl: RELEASES_URL,
      });
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('app:checkForUpdates', async () => {
    try {
      if (!app.isPackaged) {
        // electron-updater can't check in dev (no installer to compare
        // against). Surface that clearly instead of failing silently.
        return ok({ skipped: true, reason: 'Update checks only run in packaged builds.' });
      }
      const result = await autoUpdater.checkForUpdates();
      return ok({
        skipped: false,
        currentVersion: app.getVersion(),
        updateVersion: result?.updateInfo?.version || null,
      });
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('app:openReleaseNotes', async () => {
    try { await shell.openExternal(RELEASES_URL); return ok(true); }
    catch (err) { return fail(err); }
  });

  ipcMain.handle('app:openLogFolder', async () => {
    try {
      const logDir = path.join(app.getPath('userData'), 'logs');
      const result = await shell.openPath(logDir);
      // openPath returns '' on success, an error string on failure.
      if (result) throw new Error(result);
      return ok(true);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('app:openBackupFolder', async () => {
    try {
      const backupDir = path.join(app.getPath('documents'), 'HaloPSA Time Tracker', 'backups');
      const result = await shell.openPath(backupDir);
      if (result) throw new Error(result);
      return ok(true);
    } catch (err) { return fail(err); }
  });

  // ---- backups ----

  ipcMain.handle('backups:list', async () => {
    try {
      const backupDir = path.join(app.getPath('documents'), 'HaloPSA Time Tracker', 'backups');
      return ok({ backupDir, backups: _db.listBackups(backupDir) });
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('backups:restore', async (_evt, filename) => {
    try {
      if (!filename || typeof filename !== 'string') {
        throw new Error('A backup filename is required.');
      }
      // Refuse path traversal — filename only, no separators.
      if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
        throw new Error('Invalid backup filename.');
      }
      const backupDir = path.join(app.getPath('documents'), 'HaloPSA Time Tracker', 'backups');
      const backupPath = path.join(backupDir, filename);

      const parent = _getMainWindow ? _getMainWindow() : null;
      const { response } = await dialog.showMessageBox(parent && !parent.isDestroyed() ? parent : undefined, {
        type: 'warning',
        buttons: ['Restore and restart', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Restore from backup',
        message: `Restore ${filename}?`,
        detail: 'This will replace your current sessions and ticket cache with the contents of the selected backup. Your current database will be preserved as a "pre-restore" file in the app data folder in case you need to recover it. The app will restart to complete the restore.',
      });
      if (response !== 0) return ok({ confirmed: false });

      const userDataDir = app.getPath('userData');
      _db.stageRestore({ userDataDir, backupPath, expectedDir: backupDir });

      // Relaunch + quit. before-quit sets isQuitting=true so the close-to-tray
      // window handler doesn't swallow the quit.
      app.relaunch();
      app.quit();
      return ok({ confirmed: true });
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('autolaunch:set', async (_evt, enabled) => {
    try {
      app.setLoginItemSettings({
        openAtLogin: !!enabled,
        openAsHidden: true,
        args: ['--hidden'],
      });
      const settings = app.getLoginItemSettings();
      return ok({ enabled: !!settings.openAtLogin });
    } catch (err) {
      return fail(err);
    }
  });
}

module.exports = { registerIpc, readPrefs, writePrefs };
