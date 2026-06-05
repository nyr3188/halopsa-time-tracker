'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('api', {
  // settings / connection
  getStatus:        ()             => invoke('app:status'),
  saveCredentials:  (payload)      => invoke('creds:save', payload),
  clearCredentials: ()             => invoke('creds:clear'),
  testConnection:   ()             => invoke('halo:test'),
  enableDemoMode:   ()             => invoke('demo:enable'),

  // tickets
  refreshTickets:   ()             => invoke('tickets:refresh'),
  listTickets:      ()             => invoke('tickets:list'),

  // statuses
  listStatuses:     ()             => invoke('statuses:list'),

  // sessions
  startSession:     (payload)      => invoke('sessions:start', payload),
  stopSession:      (payload)      => invoke('sessions:stop', payload),
  reopenSession:    (id)           => invoke('sessions:reopen', id),
  updateSession:    (payload)      => invoke('sessions:update', payload),
  deleteSession:    (id)           => invoke('sessions:delete', id),
  listSessions:     (payload)      => invoke('sessions:list', payload),
  getRunningSession: ()            => invoke('sessions:running'),
  pushSession:      (id)           => invoke('sessions:push', id),
  pushAllUnsynced:  ()             => invoke('sessions:pushAll'),
  quickLog:         (payload)      => invoke('sessions:quickLog', payload),
  dailyTotals:      (payload)      => invoke('sessions:dailyTotals', payload),
  weeklyTotals:     (payload)      => invoke('sessions:weeklyTotals', payload),
  hoursByClient:    (payload)      => invoke('sessions:hoursByClient', payload),

  // preferences
  getPrefs:         ()             => invoke('prefs:get'),
  savePrefs:        (payload)      => invoke('prefs:save', payload),

  // launch at login
  getAutoLaunch:    ()             => invoke('autolaunch:get'),
  setAutoLaunch:    (enabled)      => invoke('autolaunch:set', enabled),

  // nudge popup
  getNudgeContext:  ()             => invoke('nudge:context'),
  snoozeNudge:      (value)        => invoke('nudge:snooze', value),
  nudgeStarted:     ()             => invoke('nudge:started'),

  // open a synced session's ticket in Halo (default browser)
  openInHalo:       (ticketId)     => invoke('app:openTicket', ticketId),

  // about / updates
  getAppInfo:       ()             => invoke('app:info'),
  checkForUpdates:  ()             => invoke('app:checkForUpdates'),
  openReleaseNotes: ()             => invoke('app:openReleaseNotes'),
  openLogFolder:    ()             => invoke('app:openLogFolder'),
  openBackupFolder: ()             => invoke('app:openBackupFolder'),

  // backups
  listBackups:      ()             => invoke('backups:list'),
  restoreBackup:    (filename)     => invoke('backups:restore', filename),

  // events from main
  onIdleAutoPaused: (handler) => {
    const listener = (_evt, payload) => handler(payload);
    ipcRenderer.on('idle:auto-paused', listener);
    return () => ipcRenderer.removeListener('idle:auto-paused', listener);
  },
  onSessionChanged: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('session:changed', listener);
    return () => ipcRenderer.removeListener('session:changed', listener);
  },
  onFocusSearch: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('hotkey:focus-search', listener);
    return () => ipcRenderer.removeListener('hotkey:focus-search', listener);
  },
  onQuickLogged: (handler) => {
    const listener = (_evt, payload) => handler(payload);
    ipcRenderer.on('hotkey:quick-logged', listener);
    return () => ipcRenderer.removeListener('hotkey:quick-logged', listener);
  },
  onTrayStopTimer: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('tray:stop-timer', listener);
    return () => ipcRenderer.removeListener('tray:stop-timer', listener);
  },
  onTrayOpenSettings: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('tray:open-settings', listener);
    return () => ipcRenderer.removeListener('tray:open-settings', listener);
  },
  onUpdateStatus: (handler) => {
    const listener = (_evt, payload) => handler(payload);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
});
