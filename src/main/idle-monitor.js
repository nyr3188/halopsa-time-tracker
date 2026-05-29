'use strict';

const { powerMonitor } = require('electron');

/**
 * IdleMonitor — polls system idle time, and on suspend/lock events.
 * When idle exceeds the configured threshold AND a session is running,
 * stops the session and back-dates the end time to when idle began.
 *
 * Renderer is notified via `idle:auto-paused` so the UI can refresh and
 * show a toast.
 */
class IdleMonitor {
  constructor({ db, getWindow, getPrefs, focusWindow }) {
    this.db = db;
    this.getWindow = getWindow;
    this.getPrefs = getPrefs;
    this.focusWindow = typeof focusWindow === 'function' ? focusWindow : null;
    this._pollHandle = null;
    this._lastTickMs = Date.now();
  }

  start() {
    if (this._pollHandle) return;
    // Poll once every 30s — accurate enough for minute-grained idle thresholds
    this._pollHandle = setInterval(() => this._tick(), 30_000);

    // Hard pauses: machine sleep, screen lock, user logoff
    powerMonitor.on('suspend',     () => this._handleHardPause('suspend'));
    powerMonitor.on('lock-screen', () => this._handleHardPause('lock-screen'));
    powerMonitor.on('shutdown',    () => this._handleHardPause('shutdown'));
  }

  stop() {
    if (this._pollHandle) {
      clearInterval(this._pollHandle);
      this._pollHandle = null;
    }
  }

  _tick() {
    try {
      const prefs = this.getPrefs();
      if (!prefs.idleAutoPauseEnabled) return;

      const running = this.db.getRunningSession();
      if (!running) return;

      const idleSec = powerMonitor.getSystemIdleTime();
      const thresholdSec = Math.max(60, (prefs.idleThresholdMinutes || 5) * 60);
      if (idleSec < thresholdSec) return;

      // Back-date end to the moment idleness began
      const idleStartedMs = Date.now() - idleSec * 1000;
      const sessionStartMs = new Date(running.start_at).getTime();
      // Never end before the session began
      const endMs = Math.max(sessionStartMs + 1000, idleStartedMs);
      const endIso = new Date(endMs).toISOString();

      const stopped = this.db.stopSession({ id: running.id, endAt: endIso });
      this._notify('idle', {
        sessionId: running.id,
        ticketId: running.ticket_id,
        ticketSummary: running.ticket_summary,
        idleMinutes: Math.round(idleSec / 60),
        endAt: endIso,
        session: stopped,
      });
    } catch (err) {
      console.error('[idle-monitor] tick failed:', err);
    }
  }

  _handleHardPause(reason) {
    try {
      const prefs = this.getPrefs();
      if (!prefs.idleAutoPauseEnabled) return;

      const running = this.db.getRunningSession();
      if (!running) return;

      // Suspend/lock fires immediately — end at "now"
      const endIso = new Date().toISOString();
      const stopped = this.db.stopSession({ id: running.id, endAt: endIso });
      this._notify(reason, {
        sessionId: running.id,
        ticketId: running.ticket_id,
        ticketSummary: running.ticket_summary,
        endAt: endIso,
        session: stopped,
      });
    } catch (err) {
      console.error('[idle-monitor] hard-pause failed:', err);
    }
  }

  _notify(reason, payload) {
    // The renderer pops a modal demanding a deliberate choice (keep stopped /
    // continue / new timer). Force the window to the front first — without
    // this, a user idling in another app would just see the taskbar icon
    // flash, and might come back hours later to a still-stopped session.
    if (this.focusWindow) {
      try { this.focusWindow(); } catch (_) { /* don't let focus failure swallow the notify */ }
    }
    const win = this.getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('idle:auto-paused', { reason, ...payload });
    }
  }
}

module.exports = { IdleMonitor };
