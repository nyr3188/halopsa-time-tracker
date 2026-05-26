'use strict';

const { app, BrowserWindow, Tray, Menu, Notification, dialog, globalShortcut, nativeImage } = require('electron');
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

// If an update finishes downloading while the nudge popup is on screen, hold
// the prompt here and re-fire it when the popup closes — avoids stacking two
// dialogs on top of each other.
let _pendingUpdate = null;

function setTrayAlert(on) {
  const wasAlert = _trayAlert;
  _trayAlert = !!on;
  if (tray) {
    const icon = nativeImage.createFromPath(trayIconPath(_trayAlert));
    if (!icon.isEmpty()) tray.setImage(icon);
    refreshTrayState();
  }
  // Nudge popup just closed — release any deferred update prompt.
  if (wasAlert && !_trayAlert && _pendingUpdate) {
    const info = _pendingUpdate;
    _pendingUpdate = null;
    promptForUpdate(info);
  }
}

function promptForUpdate(info) {
  if (!info) return;
  // Don't stack on top of the nudge popup — hold the prompt and let
  // setTrayAlert fire it once the nudge closes.
  if (_trayAlert) {
    _pendingUpdate = info;
    return;
  }
  // Make sure the user sees the dialog even if the main window is hidden to
  // tray. Re-creates the window if it was destroyed.
  showWindow();
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update ready',
    message: `Version ${info.version || ''} is ready to install.`,
    detail: 'Restart now to apply the update, or it\'ll install automatically the next time you quit the app.',
  }).then(({ response }) => {
    if (response === 0) {
      // Bypass the close→hide-to-tray handler so quitAndInstall actually
      // takes the app down.
      isQuitting = true;
      autoUpdater.quitAndInstall();
    }
  }).catch((err) => {
    log.error('Update dialog failed:', err);
  });
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
let backupHeartbeat = null;

// Hourly DB snapshot into <Documents>/HaloPSA Time Tracker/backups/. The
// daily-named file (app-YYYY-MM-DD.db) is overwritten in place on each run,
// so the folder never grows past `keep` files — but the recovery window
// shrinks from "yesterday or earlier" to "this hour".
const BACKUP_INTERVAL_MS = 60 * 60 * 1000;

function runBackupOnce(reason) {
  try {
    const backupDir = path.join(app.getPath('documents'), 'HaloPSA Time Tracker', 'backups');
    const result = db.runBackup({ targetDir: backupDir, keep: 14 });
    log.info(`DB backup (${reason}) written: ${result.path} (pruned ${result.pruned} older snapshots)`);
  } catch (err) {
    log.warn(`DB backup (${reason}) failed (continuing):`, err);
  }
}

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

  // If a restore was staged on the previous run (Settings → About →
  // Restore from backup), swap the live DB with the staged file before
  // better-sqlite3 takes its exclusive lock. The current DB and its
  // WAL/SHM sidecars are moved aside to app.pre-restore-<ts>.db* so a
  // mis-fired restore is recoverable.
  try {
    const restored = db.applyPendingRestore(userDataDir);
    if (restored) {
      log.info(`Restore applied. Previous DB preserved as ${restored.preRestorePath}`);
    }
  } catch (err) {
    log.error('Failed to apply pending restore (continuing with current DB):', err);
  }

  db.init(userDataDir);
  creds = new CredentialStore(userDataDir);

  // DB snapshots into <Documents>/HaloPSA Time Tracker/backups/. Lands in
  // OneDrive's Documents folder if the user has it synced, so the SQLite
  // file gets versioned cloud history without exposing the live DB (and its
  // WAL sidecars) to sync corruption. One snapshot per calendar day,
  // overwritten every hour while the app is running — kept to the 14 most
  // recent days. First snapshot fires now; hourly interval registered below.
  runBackupOnce('startup');

  createWindow();

  nudgeEngine = new NudgeEngine({
    db,
    getPrefs: () => readPrefs(),
    getRunningSession: () => db.getRunningSession(),
    isConfigured: () => !!creds.load(),
    onPopupStateChange: (open) => setTrayAlert(open),
  });

  // registerIpc must run before createTray — the tray's refreshTrayState
  // reads prefs via ipc.js's readPrefs(), which needs the db handle that
  // registerIpc injects. Calling createTray first throws on the very first
  // paint, which (as an unhandled rejection inside whenReady) silently aborts
  // the rest of startup — no IPC handlers, no auto-updater, broken UI.
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

  createTray();

  nudgeEngine.start();

  idleMonitor = new IdleMonitor({
    db,
    getWindow: () => mainWindow,
    getPrefs: () => readPrefs(),
  });
  idleMonitor.start();

  registerGlobalHotkeys();

  // Hourly backup heartbeat. setInterval drift across a sleep/resume cycle
  // is fine — the user-visible guarantee is "within the last hour, while the
  // app was running", and the next tick after resume catches up.
  backupHeartbeat = setInterval(() => runBackupOnce('hourly'), BACKUP_INTERVAL_MS);

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
  autoUpdater.on('update-downloaded', (info) => {
    broadcastUpdateStatus('downloaded', `Version ${info?.version || ''} ready — will install on next quit.`);
    promptForUpdate(info);
  });
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
  if (backupHeartbeat) { clearInterval(backupHeartbeat); backupHeartbeat = null; }
  // Final snapshot on the way out so a clean quit always leaves the most
  // recent state on disk, even if it's been less than an hour.
  runBackupOnce('shutdown');
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
