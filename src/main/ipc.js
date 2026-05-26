'use strict';

const { ipcMain, app, BrowserWindow } = require('electron');
const { HaloClient } = require('./halo-client');
const { MockHaloClient, MOCK_AGENT_ID } = require('./mock-halo-client');

let _db = null;
let _creds = null;
let _client = null;
let _nudge = null;
let _statusesCache = null;
let _onSessionChanged = null;

// Sessions currently mid-push to Halo. Guards against the user clicking
// "Push" twice (or Push + Push-all) and creating duplicate actions in Halo.
const _pushingIds = new Set();

// ---- preferences ----

const PREFS_DEFAULTS = Object.freeze({
  idleAutoPauseEnabled: true,
  idleThresholdMinutes: 5,
  nudgeEnabled: true,
  nudgeIntervalMinutes: 30,
  workHoursStart: '09:00',
  workHoursEnd: '17:00',
  // Comma-separated weekday numbers: 0=Sun, 1=Mon, ... 6=Sat. Default Mon–Fri.
  workDays: '1,2,3,4,5',
});

function readPrefs() {
  const raw = _db.getSetting('prefs');
  if (!raw) return { ...PREFS_DEFAULTS };
  try {
    const parsed = JSON.parse(raw);
    return { ...PREFS_DEFAULTS, ...parsed };
  } catch (_) {
    return { ...PREFS_DEFAULTS };
  }
}

function writePrefs(partial) {
  const next = { ...readPrefs(), ...(partial || {}) };
  // Light validation — clamp numerics into sane ranges
  next.idleThresholdMinutes = clamp(Number(next.idleThresholdMinutes) || 5, 1, 240);
  next.nudgeIntervalMinutes = clamp(Number(next.nudgeIntervalMinutes) || 30, 5, 240);
  next.idleAutoPauseEnabled = !!next.idleAutoPauseEnabled;
  next.nudgeEnabled = !!next.nudgeEnabled;
  _db.setSetting('prefs', JSON.stringify(next));
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

function registerIpc({ db, creds, nudge, onSessionChanged }) {
  _db = db;
  _creds = creds;
  _nudge = nudge || null;
  _onSessionChanged = typeof onSessionChanged === 'function' ? onSessionChanged : null;

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

  ipcMain.handle('autolaunch:get', async () => {
    try {
      const settings = app.getLoginItemSettings();
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
