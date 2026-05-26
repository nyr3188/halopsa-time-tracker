'use strict';

const { app, BrowserWindow, Tray, Menu, Notification, globalShortcut, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log/main');
const path = require('path');

// Persistent log under <userData>/logs/main.log. Rotates at 5 MB; keeps the
// previous file as main.old.log. Reachable from the Settings → About section
// via "Open log folder".
log.transports.file.resolvePathFn = () =>
  path.join(app.getPath('userData'), 'logs', 'main.log');
log.transports.file.maxSize = 5 * 1024 * 1024;
log.initialize();
// Surface uncaught errors and renderer console output into the same log file
// so a crash report has a single source of truth.
log.errorHandler.startCatching({ showDialog: false });
log.eventLogger.startLogging();
log.info(`App start — version ${app.getVersion()} (packaged=${app.isPackaged})`);

// electron-updater logs through whatever logger we give it.
autoUpdater.logger = log;

const db = require('./db');
const { CredentialStore } = require('./credentials');
const { registerIpc, readPrefs } = require('./ipc');
const { IdleMonitor } = require('./idle-monitor');
const { NudgeEngine } = require('./nudge-engine');

let mainWindow = null;
let tray = null;
let idleMonitor = null;
let nudgeEngine = null;
let creds = null;
let isQuitting = false;

// If "--hidden" is passed (auto-launched at login) or Windows reports we
// were started at login, don't show the window on first paint.
const startedHidden =
  process.argv.includes('--hidden') ||
  (process.platform === 'win32' && app.getLoginItemSettings().wasOpenedAtLogin);

// Only one instance at a time — second launches focus the existing window.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });
}

function broadcastUpdateStatus(state, message) {
  log.info(`[updater] ${state}: ${message}`);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('update:status', { state, message, at: new Date().toISOString() });
    }
  }
}

function trayIconPath(alert = false) {
  // Icons live in the project's assets/ folder, two levels up from src/main
  const name = alert ? 'tray-icon-alert.png' : 'tray-icon.png';
  return path.join(__dirname, '..', '..', 'assets', name);
}

// Track the most recent "alert" state (no timer + nudge popup visible) so the
// tooltip refresh can keep the right icon without the nudge engine having to
// poke us again.
let _trayAlert = false;

function setTrayAlert(on) {
  _trayAlert = !!on;
  if (!tray) return;
  const icon = nativeImage.createFromPath(trayIconPath(_trayAlert));
  if (!icon.isEmpty()) tray.setImage(icon);
  refreshTrayState();
}

function fmtElapsed(startIso) {
  const start = new Date(startIso).getTime();
  if (!Number.isFinite(start)) return '0:00';
  const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

// Rebuilds the tray's tooltip + context menu from the current session state.
// Called on a heartbeat (so elapsed time stays fresh) and whenever the IPC
// layer broadcasts a session change.
function refreshTrayState() {
  if (!tray) return;

  let running = null;
  try { running = db.getRunningSession(); } catch (_) { /* db not ready yet */ }

  // ---- tooltip ----
  if (running) {
    const summary = running.ticket_summary || `Ticket #${running.ticket_id}`;
    tray.setToolTip(`Tracking #${running.ticket_id} — ${summary} (${fmtElapsed(running.start_at)})`);
  } else {
    tray.setToolTip('HaloPSA Time Tracker — no timer running');
  }

  // ---- context menu ----
  const template = [];

  if (running) {
    const summary = running.ticket_summary || `Ticket #${running.ticket_id}`;
    template.push({
      label: `Tracking #${running.ticket_id} — ${summary}`,
      enabled: false,
    });
    template.push({
      label: `Started at ${new Date(running.start_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${fmtElapsed(running.start_at)} elapsed`,
      enabled: false,
    });
    template.push({ type: 'separator' });
    template.push({
      label: 'Stop timer…',
      click: () => {
        showWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('tray:stop-timer');
        }
      },
    });
  } else {
    template.push({ label: 'No timer running', enabled: false });
    template.push({ type: 'separator' });
    template.push({
      label: 'Quick log',
      submenu: getQuickLogPresets().map(({ minutes, accelerator }) => ({
        label: accelerator
          ? `+${minutes} min\t${accelerator.replace('Control', 'Ctrl')}`
          : `+${minutes} min`,
        click: () => handleQuickLog(minutes),
      })),
    });
  }

  template.push({ type: 'separator' });
  template.push({ label: 'Show HaloPSA Time Tracker', click: showWindow });
  template.push({
    label: 'Settings…',
    click: () => {
      showWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tray:open-settings');
      }
    },
  });
  template.push({ type: 'separator' });
  template.push({
    label: 'Quit',
    click: () => {
      isQuitting = true;
      app.quit();
    },
  });

  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    title: 'HaloPSA Time Tracker',
    backgroundColor: '#111418',
    show: !startedHidden,
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Closing the window hides it to the tray instead of quitting.
  mainWindow.on('close', (evt) => {
    if (!isQuitting) {
      evt.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// Quick-log presets are user-configurable. Built fresh from prefs each time —
// the tray menu and globalShortcut registrations both call this.
function getQuickLogPresets() {
  const prefs = readPrefs();
  const minutes = prefs.quickLogMinutes || [5, 10, 15];
  const hotkeys = prefs.hotkeys || {};
  return [0, 1, 2].map(i => ({
    minutes: minutes[i],
    accelerator: hotkeys[`quickLog${i + 1}`] || '',
  }));
}

function focusSearch() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('hotkey:focus-search');
}

function handleQuickLog(minutes) {
  try {
    // Quick-logs are intentionally unassigned. Use case: a Level 1 walks up
    // for help and Eric needs to record the time without interrupting to
    // pick a ticket (and may not be the assigned agent anyway). The session
    // sits in the log with ticket_id=0 until the user opens Edit and types
    // the real ticket number before pushing.
    const session = db.quickLogSession({ minutes });
    new Notification({
      title: `Logged ${minutes} min`,
      body: 'Open the app to assign a ticket before pushing to Halo.',
    }).show();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('session:changed');
        win.webContents.send('hotkey:quick-logged', {
          minutes,
          sessionId: session?.id || null,
        });
      }
    }
    refreshTrayState();
  } catch (err) {
    console.error('Quick-log failed:', err);
    new Notification({ title: 'Quick-log failed', body: err.message || String(err) }).show();
  }
}

function registerGlobalHotkeys() {
  // Reset everything first — this function is also called when prefs change,
  // so old accelerators need to come off before new ones go on.
  try { globalShortcut.unregisterAll(); } catch (_) { /* ignore */ }

  const prefs = readPrefs();
  const showApp = prefs.hotkeys?.showApp || '';

  // Ctrl+Alt+T (or whatever the user picked) — show window and drop focus
  // into the picker search box. Blank string = explicitly disabled.
  // If registration fails (another app holds it), fail silently so the rest
  // of the app keeps working; users can still launch via the tray icon.
  if (showApp) {
    try {
      globalShortcut.register(showApp, () => {
        showWindow();
        focusSearch();
      });
    } catch (_) { /* hotkey unavailable — ignore */ }
  }

  for (const { accelerator, minutes } of getQuickLogPresets()) {
    if (!accelerator) continue;
    try {
      globalShortcut.register(accelerator, () => handleQuickLog(minutes));
    } catch (_) { /* ignore */ }
  }
}

let trayHeartbeat = null;

function createTray() {
  let icon = nativeImage.createFromPath(trayIconPath());
  if (icon.isEmpty()) {
    // Fall back to an empty image — Electron will still render a generic icon
    icon = nativeImage.createEmpty();
  }
  tray = new Tray(icon);
  refreshTrayState();
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);

  // Keep the running-elapsed tooltip / "Started at … elapsed" menu line fresh.
  // 30s is the longest interval that still feels live for a minute-resolution
  // display; cheap enough to leave running for the life of the app.
  trayHeartbeat = setInterval(() => {
    try { refreshTrayState(); } catch (_) { /* swallow */ }
  }, 30_000);
}

app.whenReady().then(() => {
  const userDataDir = app.getPath('userData');
  db.init(userDataDir);
  creds = new CredentialStore(userDataDir);

  // Daily DB snapshot into <Documents>/HaloPSA Time Tracker/backups/. Lands
  // in OneDrive's Documents folder if the user has it synced, so the SQLite
  // file gets versioned cloud history without exposing the live DB (and its
  // WAL sidecars) to sync corruption. Kept to the 14 most recent files.
  try {
    const backupDir = path.join(app.getPath('documents'), 'HaloPSA Time Tracker', 'backups');
    const result = db.runDailyBackup({ targetDir: backupDir, keep: 14 });
    if (result.written) {
      log.info(`DB backup written: ${result.path} (pruned ${result.pruned} older snapshots)`);
    }
  } catch (err) {
    log.warn('DB backup failed (continuing):', err);
  }

  createWindow();
  createTray();

  nudgeEngine = new NudgeEngine({
    db,
    getPrefs: () => readPrefs(),
    getRunningSession: () => db.getRunningSession(),
    isConfigured: () => !!creds.load(),
    onPopupStateChange: (open) => setTrayAlert(open),
  });

  registerIpc({
    db,
    creds,
    nudge: nudgeEngine,
    getMainWindow: () => mainWindow,
    showMainWindow: showWindow,
    onSessionChanged: refreshTrayState,
    onPrefsChanged: () => {
      // Re-apply user-configurable accelerators + refresh tray submenu labels.
      registerGlobalHotkeys();
      refreshTrayState();
    },
  });

  nudgeEngine.start();

  idleMonitor = new IdleMonitor({
    db,
    getWindow: () => mainWindow,
    getPrefs: () => readPrefs(),
  });
  idleMonitor.start();

  registerGlobalHotkeys();

  // Auto-update check. electron-updater reads the publish block in
  // package.json to find GitHub Releases, downloads new installers in the
  // background, and applies them on next quit. First check fires 10s after
  // launch (gives the UI time to settle); then every 4 hours.
  // Wrapped in catches so a transient network failure can't crash the app.
  // Skipped in dev (no installer to update).
  autoUpdater.autoDownload = true;
  autoUpdater.on('checking-for-update', () => broadcastUpdateStatus('checking', 'Checking for updates…'));
  autoUpdater.on('update-available', (info) =>
    broadcastUpdateStatus('available', `Version ${info?.version || ''} available — downloading…`));
  autoUpdater.on('update-not-available', () =>
    broadcastUpdateStatus('current', 'You\'re on the latest version.'));
  autoUpdater.on('download-progress', (p) =>
    broadcastUpdateStatus('downloading', `Downloading… ${Math.round(p.percent || 0)}%`));
  autoUpdater.on('update-downloaded', (info) =>
    broadcastUpdateStatus('downloaded', `Version ${info?.version || ''} ready — will install on next quit.`));
  autoUpdater.on('error', (err) => {
    log.error('Updater error:', err);
    broadcastUpdateStatus('error', err?.message || 'Update check failed.');
  });

  if (app.isPackaged) {
    setTimeout(() => {
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    }, 10_000);
    setInterval(() => {
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    }, 4 * 60 * 60 * 1000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

// On Windows/Linux, closing the last window hides to tray instead of quitting.
// The user quits explicitly via the tray menu.
app.on('window-all-closed', () => {
  // Intentional no-op — tray keeps the app alive.
});

app.on('before-quit', () => {
  isQuitting = true;
  if (idleMonitor) idleMonitor.stop();
  if (nudgeEngine) nudgeEngine.stop();
  if (trayHeartbeat) { clearInterval(trayHeartbeat); trayHeartbeat = null; }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
