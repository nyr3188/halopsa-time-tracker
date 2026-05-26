# Changelog

All notable changes to **HaloPSA Time Tracker** are recorded here.
Versions follow [Semantic Versioning](https://semver.org/).

---

## 0.9.3 — Scrollable Settings modal

### Fixed
- **Settings modal no longer overflows the window.** With the Connection,
  Startup, Idle, Nudge, Quick-log durations, Global hotkeys, and About
  sections all stacked in one card, the modal had grown taller than a
  typical app window — Save / Cancel could end up below the screen with
  no way to reach them. The card now has a `calc(100vh - 40px)`
  max-height and the middle fieldsets sit in an internally-scrolling
  region, so the heading and Save / Cancel buttons stay pinned while
  the form scrolls behind them.

---

## 0.9.2 — Fix broken startup after 0.9.0/0.9.1 update

### Fixed
- **App no longer gets stuck at the first-run / Connect screen after
  updating.** 0.9.0 changed the tray menu to read quick-log durations
  and hotkeys from preferences, which routes through `readPrefs()` in
  `ipc.js` — and that function needs the DB handle that `registerIpc()`
  injects. But `createTray()` was called *before* `registerIpc()`, so
  the very first tray paint threw `Cannot read properties of null
  (reading 'getSetting')`. As an unhandled rejection inside the
  `app.whenReady().then(...)` chain, the throw silently aborted the
  rest of startup — no IPC handlers got registered, no auto-updater,
  no idle monitor, no global hotkeys. Existing installs would launch,
  show the renderer, and then ignore every IPC call (Connect did
  nothing, the settings panel couldn't read state, etc.).
- `createTray()` now runs *after* `registerIpc()` so the DB handle is
  in place by the time the tray paints. A code comment marks the
  ordering constraint so it doesn't regress.

### Notes
- Recovery for affected installs: download the 0.9.2 installer from
  GitHub Releases and run it manually. Auto-update from 0.9.1 won't
  work because the auto-updater is one of the things that never
  registered.
- Saved Halo credentials and the local session DB are untouched —
  re-running the installer over a broken 0.9.1 picks them right back
  up.

---

## 0.9.1 — Fix "Start with Windows" checkbox state

### Fixed
- **"Start with Windows" checkbox no longer forgets its state.** Saving
  the preference with the box checked, then closing and reopening
  Settings, would render the box unchecked even though the registry
  entry was still in place. Root cause: `app.setLoginItemSettings` was
  writing the entry with `args: ['--hidden']`, but the matching
  `app.getLoginItemSettings()` call was made with no options — so
  Electron compared the registry entry against an empty args array,
  failed to match, and reported `openAtLogin: false`. Both the get and
  set handlers now use a shared
  `{ path: process.execPath, args: ['--hidden'] }` options object so the
  read reflects what was written.

### Notes
- The actual auto-launch behavior was always wired correctly — only the
  UI's read-back was broken. If you had the checkbox enabled on 0.9.0,
  the registry entry was real and Windows would have honored it on next
  reboot; the box just looked unchecked when you reopened Settings.

---

## 0.9.0 — Weekly summary, custom hotkeys, configurable quick-logs

### Added
- **Weekly summary panel.** Sits below Daily totals and shows two
  views side-by-side:
  - **Hours by week** — Mon–Sun buckets for the last 8 weeks, keyed
    by the Monday of each week. Bucketing is local-date aware, so an
    evening session never lands in the wrong week.
  - **Hours by client (30 days)** — completed sessions grouped by the
    ticket's client name, sorted by total hours. Quick-logs and
    sessions whose ticket is no longer in the cache fall under
    "(unassigned)".
- **Configurable quick-log durations.** A new **Quick-log durations**
  fieldset in Settings lets you set the minutes logged by each of
  the three buttons (and their hotkeys). Each entry must be between
  1 and 480 minutes. The quick-log bar updates its labels and
  tooltips immediately when saved.
- **Custom global hotkeys.** A new **Global hotkeys** fieldset in
  Settings lets you rebind each of the four global shortcuts —
  show-app-and-focus-search and the three quick-log buttons. Click
  a slot, press the combo you want (modifier + key), and the new
  accelerator registers on save with no app restart. Use **Clear**
  to disable a hotkey entirely.

### Changed
- The tray's Quick-log submenu now reads its labels and accelerator
  hints from your configured durations and hotkeys.

---

## 0.8.0 — Logging, About panel, and daily DB backups

### Added
- **electron-log wired into the main process.** Persistent log file at
  `%APPDATA%/halopsa-time-tracker/logs/main.log` (rotates at 5 MB,
  keeps the previous file as `main.old.log`). Uncaught errors and
  electron-updater events stream into the same file so a crash report
  has a single source of truth. The `autoUpdater` instance now logs
  through the same transport — its previous `console.error` was
  invisible in packaged builds.
- **About section in Settings.** A new fieldset shows the running
  version (with `(dev)` suffix in `npm start`), live update status
  (Checking… / Available / Downloading N% / Ready on next quit / On
  the latest version / errors), and four buttons:
  - **Check for updates** — triggers an immediate `checkForUpdates`
    call. In dev builds, surfaces "Update checks are only available
    in packaged builds" instead of failing silently.
  - **Release notes** — opens the GitHub Releases page in the
    default browser.
  - **Open log folder** — opens `userData/logs/` in Explorer.
  - **Open backup folder** — opens the Documents backup folder
    described below.
- **Daily database snapshots to Documents.** On every app start, the
  DB is copied via `VACUUM INTO` to
  `Documents/HaloPSA Time Tracker/backups/app-YYYY-MM-DD.db`. The
  copy is a clean, defragmented single file (no WAL sidecars), so
  it's safe for OneDrive / Dropbox / whatever else syncs Documents.
  Idempotent — re-launching the app the same day is a no-op. The 14
  most recent snapshots are kept; older ones are pruned. The live DB
  stays in `userData/` to avoid cloud-sync corruption.

### Changed
- `autoUpdater` event hooks (`checking-for-update`,
  `update-available`, `download-progress`, `update-downloaded`,
  `update-not-available`, `error`) now broadcast a structured
  `update:status` IPC event to all windows so the About panel can
  reflect download progress live.

### Notes
- The live DB has not moved — it's still under `userData/`, where
  WAL sidecar files belong on a local disk. Cloud sync of the live
  WAL files is what causes SQLite corruption; copying the
  `VACUUM INTO` output into a synced folder gives you versioned
  history without that risk.

---

## 0.7.1 — Branded icon

### Changed
- **App icon, installer icon, and tray icons** now use the Nerds That
  Care glasses overlaid on a clock face, replacing the default Electron
  icon. The new `assets/icon.ico` is wired into `electron-builder` (for
  the installer + packaged window icon) and into the `BrowserWindow`
  constructor (so the dev-mode `npm start` window picks it up too).
  Tray icons (running + alert variants, with HiDPI `@2x` companions)
  use the same composition at 32px / 64px.

### Notes
- First release that actually exercises the auto-update path end-to-end:
  installed 0.7.0 builds will see this 0.7.1 release within ~10s of
  next launch (or within 4h if already running), download it in the
  background, and apply it on next quit.

---

## 0.7.0 — Auto-updates

### Added
- **Auto-updates via GitHub Releases.** The app now checks for new
  versions 10 seconds after launch and every 4 hours after that, using
  `electron-updater`. New installers are downloaded in the background;
  the OS shows a native notification when one is ready, and it installs
  on next app quit. Update checks only run in packaged builds — `npm
  start` (dev) is skipped so there's nothing to interfere with.
- Publishing is wired through to `github.com/nyr3188/halopsa-time-tracker`.
  Releases are pushed with `npm run build -- --publish always` once
  `GH_TOKEN` is set in the environment.

### Changed
- `license` field in `package.json` switched from `MIT` to `UNLICENSED`
  to match reality — this is a proprietary internal tool, not an
  open-source project.

---

## 0.6.0 — Unified Settings & a tray that actually tells you something

### Added
- **Dynamic tray tooltip.** Hovering the tray icon now shows live state
  — `Tracking #1234 — "Fix CRM sync" (1h 23m)` while a timer runs, or
  `HaloPSA Time Tracker — no timer running` when idle. Updates on every
  session change (start / stop / quick-log / nudge popup / idle
  auto-pause) and on a 30-second heartbeat so the elapsed minutes stay
  fresh without per-second churn.
- **Richer tray context menu.** Right-clicking the tray icon now shows
  the current state and lets you act on it without opening the window:
  - **Running:** a disabled status line with ticket + summary, a
    "Started at … · Nm elapsed" line, and a **Stop timer…** item that
    opens the main window with the Stop modal pre-populated.
  - **Idle:** a "No timer running" status line and a **Quick log**
    submenu with +5 / +10 / +15 entries (showing the matching
    `Ctrl+Alt+1/2/3` hotkey for muscle memory).
  - Always: **Show HaloPSA Time Tracker**, **Settings…**, and **Quit**.
- **IPC `onSessionChanged` callback for the tray.** Plumbed through
  `registerIpc` so the broadcast that already notifies the renderer
  also tells the tray to rebuild itself. Wrapped in a try/catch so a
  broken tray refresh can't kill the session-changed broadcast.

### Changed
- **Settings and Preferences are now one modal.** Previously the
  topbar had two separate buttons: **Settings** (connection panel
  with Change / Disconnect) and **Preferences** (autolaunch, idle,
  nudge). They've been folded into a single **Settings** modal with
  four sections — **Connection**, **Startup**, **Idle auto-pause**,
  and **No-timer nudge** — so everything app-config lives in one
  place. The first-run / "Change connection" form remains its own
  full-screen view (no main UI to fall back to yet), and switching
  between the two is wired up cleanly.
- The "Save" toast now reads **"Settings saved."** instead of
  "Preferences saved." to match the new unified language.

### Notes
- No DB or settings-storage changes — preferences still live under the
  same `prefs` key, and connection credentials are untouched. Existing
  installs upgrade in place.

---

## 0.5.2 — Layout polish & daily-totals timezone fix

### Fixed
- **Daily totals now bucket by your local calendar date.** Sessions are
  stored as ISO 8601 UTC; the aggregation was previously bucketing on
  the raw UTC date string, so evening sessions (e.g. 8 PM EDT) landed
  in the *next* day's UTC bucket and showed up on the wrong card. Both
  ends are now local-date aware: the SQL aggregation uses
  `datetime(start_at, 'localtime')` before substringing, and the
  renderer builds its 7-day keys from `getFullYear/getMonth/getDate`
  instead of `toISOString().slice(0,10)`.

### Changed
- **Sessions log is now capped at ~420px tall with a sticky header.**
  Previously the table grew without bound and would push the daily
  totals strip below the fold once enough sessions accumulated. The
  list now scrolls internally while the column headers stay pinned.
- **After-hours nudge wording retuned.** The popup now reads "Your
  workday has ended. If you're still working on something, start a
  timer — otherwise, snooze until [next work period]" instead of the
  earlier "It's outside your work hours…" phrasing. Same fallback
  copy applies when no next-period label is available.

---

## 0.5.1 — Quick-log redesign & push reliability

### Fixed
- **Ticket status updates now actually stick.** Previously the chosen status
  was piggy-backed onto the `POST /Actions` body, which Halo silently ignored
  for both tickets and project tasks. The push now makes a second
  `POST /Tickets` call with `[{id, status_id}]` to flip the status
  explicitly. If the time push succeeds but the status flip fails, the
  session is still marked synced and a `statusWarning` toast surfaces the
  partial-failure.
- **Double-clicking Push no longer creates duplicate Halo actions.** Two
  layers of protection:
  - **Backend:** the IPC layer keeps a module-level `Set` of session IDs
    currently mid-push. A second invocation returns "already being pushed"
    immediately, with a `try/finally` to guarantee the lock releases even
    on error. Push-all uses the same lock per-session.
  - **Frontend:** the Push button is disabled while the request is in
    flight (and re-enabled on error so the user can retry).

### Changed
- **Quick-log is now drive-by-help-shaped.** The +5 / +10 / +15 buttons
  (and `Ctrl+Alt+1/2/3` hotkeys) create an **unassigned** session
  (`ticket_id = 0`) with a placeholder summary. The earlier "most recent
  ticket" guess didn't fit the actual workflow — Eric typically isn't the
  assigned agent on a ticket he's helping a Level 1 with.
- The Edit modal now has a **Ticket number** field at the top, with an
  explanatory hint that only appears for unassigned (quick-logged)
  sessions. Push is disabled until a positive integer is entered;
  Push-all skips unassigned rows with a clear error. If the typed
  ticket ID matches a cached ticket or project task, its real summary
  is filled in; otherwise the row reads "Ticket #N".
- Unassigned sessions render with a purple **unassigned** badge and a
  subtle row tint so they're easy to spot in the log.

### Removed
- `db.getMostRecentTicket()` — no longer used now that quick-logs are
  always unassigned.

---

## 0.5.0 — Quick-log & global hotkeys

### Added
- **Quick-log bar** above the timer panel with **+5 min**, **+10 min**,
  and **+15 min** buttons for tiny interruptions. (Originally targeted at
  the currently-running or most-recent ticket; redesigned in 0.5.1 to
  always create unassigned sessions.)
- **Global hotkeys** (registered via `globalShortcut`; fail silently if
  another app already owns the combo):
  - `Ctrl+Alt+T` — show the window and focus the search box on the
    active tab.
  - `Ctrl+Alt+1` / `2` / `3` — quick-log 5 / 10 / 15 minutes without
    opening the window. A Windows notification confirms the log.
- **Enter to start** — pressing Enter inside either search box starts
  a session on the currently-selected row.

---

## 0.4.2 — Status pill polish & nudge fix

### Fixed
- **Nudge engine no longer fires outside work hours.** The work-hours
  check was reading the day-of-week wrong, so the nudge could fire on
  Saturdays for users on the default Mon–Fri schedule.
- **Status name resolved from ID** when Halo returns a ticket with a
  `status_id` but no `status_name`. The picker rows would previously
  render a blank pill in that case.

### Changed
- **Status pills now use Halo's own colors.** Each ticket / project task
  row shows its current status as a coloured pill, with the colour
  pulled from the Halo status record's `colour` field. Falls back to a
  neutral pill when no colour is set.

---

## 0.4.1 — Tabs & the connected settings panel

### Changed
- **Picker split into Tickets and Project Tasks tabs.** Previously
  everything dumped into a single list. Now:
  - **Tickets** — flat list of regular tickets assigned to you.
  - **Project Tasks** — three-level tree: Customer → Parent Project →
    Task. Parent projects collapse/expand with a caret. Tasks missing
    a parent fall under a synthetic "Other tasks" group within their
    client.
  - Per-tab search; the active tab persists between Start / Stop cycles.
- **"Connected" settings panel.** Opening Settings while already
  configured now shows the current connection details (URL, signed-in
  email, agent ID) with **Change connection** and **Disconnect** buttons,
  instead of dumping you back into an empty form. First-run and
  "Change connection" still use the original form.

---

## 0.4.0 — Project tasks & ticket statuses

### Added
- **Project tasks alongside regular tickets.** The Halo client optionally
  pulls project tasks (toggled by the "Include project tasks" checkbox
  in Settings) and merges them into the local ticket cache. Parent
  project columns (`parent_project_id`, `parent_project_summary`) are
  persisted so the picker can group tasks by their parent.
- **Status picker on stop and edit.** The Stop modal and Edit modal both
  expose an optional "Set ticket status" dropdown, populated from Halo's
  `/Status` endpoint. The chosen status is persisted on the local
  session and applied when the session is pushed. Closed statuses are
  filtered out — there's no sensible workflow where you'd log time and
  close the ticket in the same step.
- **Status-on-push in the Halo client.** Initial implementation set
  `status_id` directly on the `POST /Actions` body (later discovered to
  be silently ignored — see 0.5.1 for the fix).

---

## 0.3.0 — Tray, autolaunch, and the no-timer nudge

### Added
- **System tray + hide-on-close.** Closing the main window now hides
  to the tray; the app keeps running and is reopened via the tray icon
  (single- or double-click) or the tray menu. **Quit** in the tray menu
  is the only path that actually exits.
- **Launch at login.** A Startup section in Preferences toggles the
  Windows / macOS login item; the app starts hidden (`--hidden` arg) so
  it lands quietly in the tray.
- **No-timer nudge.** A small popup appears when no session is running
  during configured work hours, with snooze options and a one-click
  "start tracking" path. Configurable interval, work hours, and weekdays
  in Preferences.
- **Idle auto-pause.** When the machine is idle past the configured
  threshold (or sleeps / locks the screen), the running session is
  stopped and back-dated to when idleness began. The toast tells you
  *why* it stopped (idle / suspend / lock-screen / shutdown).
- **Alert tray icon** when no timer is running so the tray gives a
  glanceable status.

### Changed
- Removed the earlier renderer-side nudge code in favour of the new
  main-process `NudgeEngine`.

---

## 0.2.0 — Demo Mode & daily totals

### Added
- **Demo Mode.** A "Try Demo Mode" path on the first-run screen loads
  sample tickets and a mock Halo client so the app can be evaluated
  without real Halo credentials. All features work normally except
  pushing time entries. A persistent demo banner makes the state
  obvious; **Exit Demo Mode** wipes the sample state and returns to
  first-run.
- **Daily totals strip.** A 7-day overview of hours and session count
  per day, sitting below the sessions log.
- **Push all unsynced** as a single action on the sessions log header,
  in addition to per-row Push.

### Changed
- Sessions list shows **Local / Synced / Running** badges, with synced
  rows rendered dimmer to keep focus on what still needs pushing.

---

## 0.1.0 — Initial build

### Added
- Electron 32 shell with a dark, single-purpose UI.
- HaloPSA OAuth **client credentials** flow; credentials encrypted at
  rest with Electron's `safeStorage`.
- Settings / first-run screen — enter Halo URL, Client ID, Client
  Secret, and your agent email; the app verifies the connection and
  resolves your agent ID before saving.
- Local **SQLite cache** (better-sqlite3) of tickets assigned to the
  signed-in agent, with a **Refresh tickets** button.
- **Start / Stop timer** with a free-text note prompt on stop, and a
  live elapsed-time display while running.
- **Sessions log** with manual Edit and Delete on local sessions, and
  per-row **Push** to Halo as a private ticket action.

---

## Notes

- This file is maintained by hand; `package.json` holds the canonical
  current version.
- The 0.4.x split (which features landed in 0.4.0 vs 0.4.1 vs 0.4.2)
  is reconstructed from working notes — if any entry is in the wrong
  release, tell me and I'll move it.
