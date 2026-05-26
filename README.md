# HaloPSA Time Tracker

A desktop app for tracking working time against your HaloPSA tickets and project tasks. Records actual start/end timestamps (not a stopwatch), stores everything locally, and pushes notes + time to HaloPSA on demand.

## What it does

- Pulls the tickets and project tasks currently assigned to you in HaloPSA
- Lets you start a session on a ticket or project task; records the actual start timestamp
- When you stop, records the actual end timestamp and prompts for a note (and an optional status change for the ticket)
- **Quick-log** drive-by help (+5 / +10 / +15 minutes) without picking a ticket up front
- **Global hotkeys** — open the app, focus the picker, or quick-log time without leaving your current window
- **Idle auto-pause** stops your timer when you step away, your screen locks, or your machine sleeps
- **No-timer nudge** gives you a gentle reminder during your configured work hours if nothing is running
- Lives in the **system tray** — closing the window keeps the app running so hotkeys and nudges stay active
- Keeps a local log of sessions you can edit before syncing
- Pushes each session to its ticket as a HaloPSA Action (note + time), and optionally flips the ticket's status in the same step
- **Demo Mode** lets you try the app with sample tickets — no Halo credentials required
- All session data lives in a local SQLite file; credentials are encrypted via the OS keychain (Windows DPAPI)

## One-time setup in HaloPSA

1. Sign in to your HaloPSA instance as an admin (or ask one to do this for you)
2. Go to **Configuration → Integrations → Halo API**
3. Click **New**
4. Set **Authentication Method** to **Client ID and Secret (Services)**
5. Give it a name (e.g. "Eric Time Tracker")
6. Under **Permissions**, grant the following four scopes (and nothing else): `read:tickets`, `edit:tickets`, `read:projects`, `edit:projects`
7. Save, then copy the **Client ID** and **Client Secret** — you'll paste them into the app on first launch
8. Note your instance URL (e.g. `https://yourcompany.halopsa.com`)

## Install and run (Windows)

You need Node.js 18+ installed. Open PowerShell in the project folder and run:

```powershell
npm install
npm start
```

The first launch shows a settings screen. You have two paths:

- **Connect to HaloPSA** — enter your Halo URL, Client ID, Client Secret, your agent email, and whether to include project tasks alongside regular tickets. The app verifies the credentials and resolves your agent ID before saving.
- **Try Demo Mode** — loads sample tickets and a mock Halo client. Every feature works except pushing time entries. You can switch to a real connection any time.

## Build a standalone installer

To get a `.exe` installer you can run on any Windows machine without Node:

```powershell
npm run build
```

The installer will land in `dist/`.

## How sessions work

### Timed sessions (normal flow)

- **Start** records `start_at` = now (your local clock)
- **Stop** records `end_at` = now and pops a modal that prompts for a note and (optionally) a new ticket status
- Sessions live in a local DB until you push — at which point each session becomes a HaloPSA Action on its ticket, with:
  - `note` = the text you entered
  - `timetaken` = (end − start) in decimal hours, rounded to nearest minute
  - `datetime` = your `start_at` (so the action's timestamp is when the work actually happened)
- If you picked a status, the app makes a second call to flip the ticket's status. If that step fails after the time has been logged, a warning toast surfaces the partial-failure and the session is still marked synced.
- After a successful push, the session is marked synced and locked from edits
- **Push all unsynced** in the sessions header pushes every unpushed session in one go

### Quick-log (drive-by help)

When a Level 1 walks over for help on a ticket you're not the agent on, you don't always want to interrupt to pick a ticket. The quick-log bar handles that:

- **+5 / +10 / +15 min** buttons (or `Ctrl+Alt+1/2/3` globally) create an **unassigned** session ending now
- The session shows in the log with a purple "unassigned" badge and a `no ticket — edit to assign` hint
- It can't be pushed until you click **Edit** on the row and type the ticket number you helped with — the app will fill in the real summary if it's a ticket you have cached, otherwise it stamps a placeholder
- Push-all skips unassigned rows so you don't accidentally push half-finished entries

### Editing sessions

Click **Edit** on any unpushed row to adjust the ticket number, start, end, note, or status. Synced rows are locked.

### Tickets vs. Project Tasks

The picker has two tabs:
- **Tickets** — flat list of regular tickets assigned to you, with each ticket's current status shown as a colored pill (colors come straight from Halo's status configuration)
- **Project Tasks** — three-level tree: Customer → Parent Project → Task. Parent projects expand and collapse with a caret. Tasks without a parent fall under an "Other tasks" group.

Per-tab search filters by ID, summary, client, or status. Pressing **Enter** in either search box starts a session on the currently-selected row.

### Daily totals

A 7-day strip under the sessions log shows hours and session counts per day, so you can spot gaps before you push.

### Weekly summary

A panel below Daily totals shows two views side-by-side:

- **Hours by week** — Mon–Sun buckets for the last 8 weeks, keyed by the Monday of each week.
- **Hours by client (30 days)** — completed sessions grouped by the ticket's client name, sorted by total hours. Quick-logs and sessions whose ticket is no longer in the cache fall under "(unassigned)".

## Preferences

Open **Preferences** in the top bar to configure:

- **Startup** — toggle "Start automatically when I log in to Windows". The app starts hidden in the tray.
- **Idle auto-pause** — when your machine is idle past the configured threshold (or it sleeps / locks the screen / shuts down), the running session is stopped and back-dated to when idleness began. The toast tells you *why* it stopped.
- **No-timer nudge** — a small popup appears during configured work hours when no timer is running. Configurable interval, work hours start/end, and weekdays. One-click "start tracking" path; snooze options included.
- **Quick-log durations** — set how many minutes each quick-log button (and its hotkey) logs. Each entry must be 1–480 minutes. Changes apply immediately on save.
- **Global hotkeys** — rebind any of the four global shortcuts (show app, three quick-logs). Click a slot, press the combo, save. Use **Clear** to disable a hotkey entirely.

## Global hotkeys

These work from anywhere on your machine while the app is running. The defaults are:

- `Ctrl+Alt+T` — show the window and focus the picker's search box
- `Ctrl+Alt+1` — quick-log button 1 (default: 5 minutes, unassigned)
- `Ctrl+Alt+2` — quick-log button 2 (default: 10 minutes, unassigned)
- `Ctrl+Alt+3` — quick-log button 3 (default: 15 minutes, unassigned)

All four are user-configurable in **Settings → Global hotkeys**. A Windows toast confirms each quick-log. If another app already owns one of these combos, the hotkey is skipped silently — the rest of the app still works. Rebind it to something else from the Settings panel.

## Tray behavior

- Closing the main window **hides to the tray** — the app keeps running so hotkeys, nudges, and idle detection stay active
- Single-click or double-click the tray icon to reopen the window
- The tray icon shifts to an **alert** appearance when no timer is running so you can glance at it for status
- **Quit** in the tray menu is the only path that actually exits the app

## Settings panel

Opening **Settings** while already connected shows your current connection details — Halo URL, signed-in email, agent ID — with buttons to **Change connection** or **Disconnect**, rather than dumping you back into an empty form. First-run setup and "Change connection" still use the form.

## Updates

Installed builds check GitHub Releases for a newer version 10 seconds after launch and every 4 hours after that. When one is found it downloads in the background and Windows shows a notification; the new version installs automatically the next time you quit the app. No manual reinstall needed.

You can also check on demand from **Settings → About**, which shows the running version, the latest update status, and buttons for **Check for updates**, **Release notes**, **Open log folder**, and **Open backup folder**.

## Logs

The app keeps a persistent log at `%APPDATA%/halopsa-time-tracker/logs/main.log` (rotates at 5 MB, keeps the previous file as `main.old.log`). It captures startup, auto-update events, idle-monitor transitions, and any uncaught errors. **Settings → About → Open log folder** opens it directly.

## Database backups

On every launch the app writes a clean snapshot of the SQLite database to `Documents/HaloPSA Time Tracker/backups/app-YYYY-MM-DD.db`. The snapshot is produced via SQLite's `VACUUM INTO`, which writes a single defragmented file with no WAL sidecars — safe to drop into a OneDrive- or Dropbox-synced Documents folder. The 14 most recent snapshots are kept; older ones are pruned automatically. The live DB itself stays in `%APPDATA%/halopsa-time-tracker/` (sync of the live `*.db-wal` files is what corrupts SQLite, so we deliberately do not move it).

## Where things live

- **Config + DB**: `%APPDATA%/halopsa-time-tracker/` on Windows
  - `app.db` — SQLite file with tickets cache, session log, and preferences
  - `credentials.bin` — encrypted (DPAPI) Halo credentials
- **Source**: `src/main/` (Node) and `src/renderer/` (UI)
- **Changelog**: `CHANGELOG.md` in the project root

## Troubleshooting

- **"Could not resolve agent"** on connect: your email in the app doesn't match an active agent in Halo. Check spelling, or ask an admin to confirm the email on your `/Agent` record.
- **401 on push**: the API app is missing one of the required scopes. Re-check the Halo API app in **Configuration → Integrations → Halo API** and make sure it has `read:tickets`, `edit:tickets`, `read:projects`, and `edit:projects`.
- **Tickets list empty**: by default the app fetches open tickets where you are the assigned agent. If you only have project tasks, make sure **Include project tasks** is checked in Settings.
- **Status update failed after push**: the time was logged successfully but Halo refused the status change. Common causes: the status is restricted to specific roles, or the ticket requires fields to be set before moving to that status. The session is still marked synced — re-apply the status in Halo directly.
- **Quick-log hotkey doesn't fire**: another app may have grabbed `Ctrl+Alt+1/2/3` or `Ctrl+Alt+T`. Check apps like Discord, OBS, or screen-capture tools and remap their global shortcuts.
- **Tray icon missing after close**: on some Windows setups the tray icon hides in the overflow tray (^). Drag it onto the main tray for one-click access.
- **Can't rebuild native module on install**: run `npm run rebuild` to recompile `better-sqlite3` against the Electron version.
