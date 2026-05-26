'use strict';

const path = require('path');
const { BrowserWindow, screen, nativeImage } = require('electron');

const POPUP_WIDTH = 420;
const POPUP_HEIGHT = 340;
const POPUP_MARGIN = 16;
const CHECK_INTERVAL_MS = 60 * 1000;

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

class NudgeEngine {
  constructor({ db, getPrefs, getRunningSession, isConfigured, onPopupStateChange }) {
    this.db = db;
    this.getPrefs = getPrefs;
    this.getRunningSession = getRunningSession;
    this.isConfigured = isConfigured;
    this.onPopupStateChange = onPopupStateChange || (() => {});

    this.popup = null;
    this.popupMode = null;
    this.popupContext = null;
    this.lastNudgeAt = Date.now(); // don't fire immediately on launch
    this.snoozedUntil = 0;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), CHECK_INTERVAL_MS);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.closePopup();
  }

  /** Call after the user starts a timer so we don't immediately nudge again. */
  markActivity() {
    this.lastNudgeAt = Date.now();
    this.snoozedUntil = 0;
  }

  snooze(value) {
    const now = Date.now();
    if (value === 'next-period') {
      const target = nextWorkPeriodStart(new Date(), this.getPrefs());
      if (target) this.snoozedUntil = target.getTime();
      else this.snoozedUntil = now + 60 * 60 * 1000;
    } else {
      const minutes = Number(value) || 15;
      this.snoozedUntil = now + minutes * 60 * 1000;
    }
    this.lastNudgeAt = now;
    this.closePopup();
  }

  getPopupContext() {
    return this.popupContext;
  }

  isPopupOpen() {
    return !!(this.popup && !this.popup.isDestroyed());
  }

  tick() {
    try {
      if (this.isPopupOpen()) return;
      if (!this.isConfigured()) return;

      const prefs = this.getPrefs();
      if (!prefs.nudgeEnabled) return;

      const running = this.getRunningSession();
      if (running) return;

      const now = new Date();
      if (now.getTime() < this.snoozedUntil) return;

      const intervalMs = (prefs.nudgeIntervalMinutes || 30) * 60 * 1000;
      if (now.getTime() - this.lastNudgeAt < intervalMs) return;

      const inHours = isWithinWorkHours(now, prefs);
      const mode = inHours ? 'in-hours' : 'after-hours';

      // After-hours nudges still respect the same cadence; we just show a different popup.
      this.lastNudgeAt = now.getTime();
      this.openPopup(mode);
    } catch (err) {
      // Swallow — don't let nudge errors crash the timer
      console.error('Nudge tick error:', err);
    }
  }

  openPopup(mode) {
    if (this.isPopupOpen()) return;

    const prefs = this.getPrefs();
    const nextStart = nextWorkPeriodStart(new Date(), prefs);
    const nextWorkPeriodLabel = nextStart ? formatWorkPeriodLabel(nextStart) : '';

    this.popupMode = mode;
    this.popupContext = { mode, nextWorkPeriodLabel };

    const { workArea } = screen.getPrimaryDisplay();
    const x = workArea.x + workArea.width - POPUP_WIDTH - POPUP_MARGIN;
    const y = workArea.y + workArea.height - POPUP_HEIGHT - POPUP_MARGIN;

    this.popup = new BrowserWindow({
      width: POPUP_WIDTH,
      height: POPUP_HEIGHT,
      x,
      y,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      transparent: false,
      backgroundColor: '#1b1f24',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    this.popup.setMenuBarVisibility(false);
    this.popup.loadFile(path.join(__dirname, '..', 'renderer', 'nudge.html'));

    this.popup.once('ready-to-show', () => {
      if (!this.popup) return;
      // Make sure the popup floats above fullscreen windows on Windows
      this.popup.setAlwaysOnTop(true, 'screen-saver');
      this.popup.show();
      this.popup.focus();
    });

    this.popup.on('closed', () => {
      this.popup = null;
      this.popupMode = null;
      this.popupContext = null;
      this.onPopupStateChange(false);
    });

    this.onPopupStateChange(true);
  }

  closePopup() {
    if (this.popup && !this.popup.isDestroyed()) {
      this.popup.close();
    }
    this.popup = null;
    this.popupMode = null;
    this.popupContext = null;
  }
}

// ---------- helpers ----------

function hhmmToMinutes(s) {
  if (!s || !/^\d{2}:\d{2}$/.test(s)) return null;
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

function isWithinWorkHours(now, prefs) {
  const days = new Set(String(prefs.workDays || '').split(',').map(s => s.trim()).filter(Boolean));
  if (!days.has(String(now.getDay()))) return false;
  const start = hhmmToMinutes(prefs.workHoursStart);
  const end = hhmmToMinutes(prefs.workHoursEnd);
  if (start == null || end == null) return false;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return nowMin >= start && nowMin < end;
}

/**
 * Find the next work-period start strictly *after* the given time.
 * Walks forward day-by-day for up to 14 days; returns null if no valid window found.
 */
function nextWorkPeriodStart(from, prefs) {
  const days = new Set(String(prefs.workDays || '').split(',').map(s => s.trim()).filter(Boolean));
  const startMin = hhmmToMinutes(prefs.workHoursStart);
  if (days.size === 0 || startMin == null) return null;

  const startH = Math.floor(startMin / 60);
  const startM = startMin % 60;

  // Check today first — if it's a work day AND we're before the start hour, today qualifies
  for (let offset = 0; offset < 14; offset += 1) {
    const candidate = new Date(from);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(startH, startM, 0, 0);

    if (!days.has(String(candidate.getDay()))) continue;
    if (candidate.getTime() <= from.getTime()) continue;
    return candidate;
  }
  return null;
}

function formatWorkPeriodLabel(date) {
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = date.toDateString() === tomorrow.toDateString();

  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `today at ${time}`;
  if (isTomorrow) return `tomorrow at ${time}`;
  return `${WEEKDAY_NAMES[date.getDay()]} at ${time}`;
}

module.exports = { NudgeEngine, isWithinWorkHours, nextWorkPeriodStart };
