'use strict';

// ---------- helpers ----------

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function show(el)   { el.classList.remove('hidden'); }
function hide(el)   { el.classList.add('hidden'); }

function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = 'toast ' + kind;
  show(el);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => hide(el), 3500);
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function fmtDuration(startIso, endIso) {
  if (!startIso) return '—';
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtHoursDecimal(startIso, endIso) {
  if (!startIso || !endIso) return '—';
  const minutes = Math.round((new Date(endIso) - new Date(startIso)) / 60000);
  if (minutes <= 0) return '0:00';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function isoToLocalDatetimeInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localDatetimeInputToIso(value) {
  if (!value) return null;
  const d = new Date(value);
  return d.toISOString();
}

async function callApi(name, ...args) {
  const res = await window.api[name](...args);
  if (!res || !res.ok) {
    const message = res?.error || 'Unknown error';
    toast(message, 'error');
    throw new Error(message);
  }
  return res.data;
}

// ---------- state ----------

const state = {
  tickets: [],
  projects: [],
  sessions: [],
  statuses: [],
  selectedTicketId: null,
  selectedProjectTaskId: null,
  activeTab: 'tickets',
  running: null,
  configured: false,
  demoMode: false,
  prefs: null,
  autoLaunch: false,
  lastStatus: null,
};

// ---------- boot ----------

async function boot() {
  const status = await callApi('getStatus').catch(() => null);
  if (!status?.configured) {
    showSettingsView({ firstRun: true });
    return;
  }
  state.configured = true;
  applyStatus(status);
  show($('#main-view'));
  await refreshAll();
}

function applyStatus(status) {
  state.lastStatus = status;
  state.demoMode = !!status?.demoMode;
  if (state.demoMode) {
    $('#conn-status').textContent = 'Demo Mode';
    show($('#demo-banner'));
  } else {
    $('#conn-status').textContent = `Connected · ${status.baseUrl}`;
    hide($('#demo-banner'));
  }
}

async function refreshAll() {
  await Promise.all([
    loadTickets(),
    loadSessions(),
    loadRunning(),
    loadDailyTotals(),
    loadWeeklySummary(),
    loadPrefs(),
    loadStatuses(),
  ]);
}

// ---------- settings ----------

function renderConnectedPanel() {
  const s = state.lastStatus;
  if (!s) return;
  $('#conn-panel-dot').classList.toggle('demo', !!s.demoMode);
  if (s.demoMode) {
    $('#conn-panel-title').textContent = 'Running in Demo Mode';
    $('#conn-panel-url').textContent = '— (sample data, not connected to Halo)';
    $('#conn-panel-email').textContent = 'demo@local';
    $('#conn-panel-agent').textContent = 'demo';
  } else {
    $('#conn-panel-title').textContent = 'Connected to HaloPSA';
    $('#conn-panel-url').textContent = s.baseUrl || '—';
    $('#conn-panel-email').textContent = s.email || '—';
    $('#conn-panel-agent').textContent = s.agentId ? `#${s.agentId}` : '—';
  }
}

// Full-screen view — used for first-run and "Change connection". When
// `firstRun` is true the Cancel button is hidden (no main view to go back
// to yet); otherwise the user can bail out and return to the main view.
function showSettingsView({ firstRun = false } = {}) {
  hide($('#main-view'));
  hide($('#settings-modal'));
  show($('#settings-view'));
  $('#settings-error').textContent = '';

  if (firstRun) {
    hide($('#settings-cancel'));
    // Clear any prefilled values
    $('#settings-form').reset();
    $('#settings-form').elements.scope.value = 'all';
    $('#settings-form').elements.includeProjects.checked = true;
  } else {
    show($('#settings-cancel'));
    // Pre-fill what we know (the secret is never read back)
    const s = state.lastStatus;
    if (s && !s.demoMode) {
      const form = $('#settings-form');
      if (s.baseUrl) form.elements.baseUrl.value = s.baseUrl;
      if (s.email)   form.elements.email.value   = s.email;
    }
  }
}

$('#settings-form').addEventListener('submit', async (evt) => {
  evt.preventDefault();
  const fd = new FormData(evt.currentTarget);
  const payload = {
    baseUrl:        fd.get('baseUrl'),
    clientId:       fd.get('clientId'),
    clientSecret:   fd.get('clientSecret'),
    email:          fd.get('email'),
    scope:          fd.get('scope') || 'all',
    includeProjects: fd.get('includeProjects') === 'on',
  };
  $('#settings-error').textContent = '';
  const btn = evt.target.querySelector('button[type="submit"]');
  btn.disabled = true; btn.textContent = 'Connecting…';
  try {
    const res = await window.api.saveCredentials(payload);
    if (!res.ok) {
      $('#settings-error').textContent = res.error;
      return;
    }
    toast(`Connected. Resolved as agent #${res.data.agentId}.`, 'success');
    hide($('#settings-view'));
    show($('#main-view'));
    state.configured = true;
    const status = await callApi('getStatus');
    applyStatus(status);
    await refreshTicketsFromHalo();
    await loadStatuses();
    await loadSessions();
    await loadRunning();
    await loadDailyTotals();
  } finally {
    btn.disabled = false; btn.textContent = 'Connect';
  }
});

$('#settings-cancel').addEventListener('click', () => {
  // If we're configured, going back to the Settings modal makes more sense
  // than closing the whole view from an empty form.
  hide($('#settings-view'));
  if (state.configured) {
    show($('#main-view'));
    showSettingsModal();
  } else {
    show($('#main-view'));
  }
});

$('#settings-change').addEventListener('click', () => {
  hide($('#settings-modal'));
  showSettingsView({ firstRun: false });
});

$('#settings-disconnect').addEventListener('click', async () => {
  if (!confirm('Disconnect from Halo? Your local session history will be kept, but you\'ll need to reconnect to push any new time entries.')) return;
  await callApi('clearCredentials');
  state.configured = false;
  state.demoMode = false;
  state.tickets = [];
  state.projects = [];
  state.statuses = [];
  state.lastStatus = null;
  hide($('#demo-banner'));
  hide($('#settings-modal'));
  showSettingsView({ firstRun: true });
});

$('#open-settings').addEventListener('click', showSettingsModal);

$('#demo-enable').addEventListener('click', async () => {
  const btn = $('#demo-enable');
  btn.disabled = true; const original = btn.textContent; btn.textContent = 'Loading…';
  $('#settings-error').textContent = '';
  try {
    const res = await window.api.enableDemoMode();
    if (!res.ok) {
      $('#settings-error').textContent = res.error;
      return;
    }
    toast('Demo Mode enabled. Sample tickets loaded.', 'success');
    hide($('#settings-view'));
    show($('#main-view'));
    state.configured = true;
    const status = await callApi('getStatus');
    applyStatus(status);
    await refreshTicketsFromHalo();
    await loadStatuses();
    await loadSessions();
    await loadRunning();
    await loadDailyTotals();
  } finally {
    btn.disabled = false; btn.textContent = original;
  }
});

$('#demo-exit').addEventListener('click', async () => {
  if (!confirm('Exit Demo Mode? Sample tickets will be cleared. Any local sessions you started in demo will remain in the log.')) return;
  await callApi('clearCredentials');
  state.configured = false;
  state.demoMode = false;
  state.tickets = [];
  state.projects = [];
  state.statuses = [];
  state.lastStatus = null;
  hide($('#demo-banner'));
  showSettingsView({ firstRun: true });
});

// ---------- statuses ----------

async function loadStatuses() {
  try {
    state.statuses = await callApi('listStatuses');
  } catch (_) {
    state.statuses = [];
  }
  populateStatusDropdowns();
  // Pills need the status colour map; re-render any visible lists.
  if ($('#ticket-list')) renderTicketsTab();
  if ($('#project-tree')) renderProjectsTab();
}

// Quick-logs always produce sessions with ticket_id === 0 ("unassigned").
// The user must edit the session to assign a real ticket number before
// pushing — handles the "Level 1 walks up for help on a ticket I'm not
// the agent on" workflow.
function isUnassigned(session) {
  return !session || !session.ticket_id;
}

function statusByName(name) {
  if (!name) return null;
  return state.statuses.find(s => s.name === name) || null;
}

function statusById(id) {
  if (id == null) return null;
  return state.statuses.find(s => s.id === Number(id)) || null;
}

function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}, ${alpha})`;
}

// Build a status pill from a ticket-like object. Halo sometimes returns
// status_id without status_name, so fall back to the loaded statuses list.
function statusPill(ticket) {
  if (!ticket) return null;
  const byName = statusByName(ticket.status_name);
  const byId   = byName ? null : statusById(ticket.status_id);
  const status = byName || byId;
  const label  = status?.name || ticket.status_name || '';
  if (!label) return null;
  const el = document.createElement('span');
  el.className = 'status-pill';
  el.textContent = label;
  const colour = status?.colour || null;
  if (colour) {
    el.style.color = colour;
    el.style.borderColor = colour;
    const bg = hexToRgba(colour, 0.12);
    if (bg) el.style.background = bg;
  }
  return el;
}

function populateStatusDropdowns() {
  for (const id of ['#stop-status', '#edit-status']) {
    const sel = $(id);
    if (!sel) continue;
    const preserve = sel.value;
    sel.innerHTML = '<option value="">Don\'t change status</option>';
    for (const s of state.statuses) {
      const opt = document.createElement('option');
      opt.value = String(s.id);
      opt.textContent = s.name;
      sel.appendChild(opt);
    }
    if (preserve) sel.value = preserve;
  }
}

// ---------- tickets / projects (tabs) ----------

async function loadTickets() {
  const all = await callApi('listTickets');
  state.tickets  = all.filter(t => !t.is_project);
  state.projects = all.filter(t =>  t.is_project);
  if (all.length === 0) {
    await refreshTicketsFromHalo();
    return;
  }
  renderTicketsTab();
  renderProjectsTab();
  updateTabCounts();
}

async function refreshTicketsFromHalo() {
  const btn = $('#refresh-tickets');
  btn.disabled = true; const original = btn.textContent; btn.textContent = 'Refreshing…';
  try {
    const res = await callApi('refreshTickets');
    const all = res.tickets || [];
    state.tickets  = all.filter(t => !t.is_project);
    state.projects = all.filter(t =>  t.is_project);
    renderTicketsTab();
    renderProjectsTab();
    updateTabCounts();
    toast(`Loaded ${res.count} item${res.count === 1 ? '' : 's'} from Halo.`, 'success');
  } catch (_) { /* toast already shown */ }
  finally {
    btn.disabled = false; btn.textContent = original;
  }
}

$('#refresh-tickets').addEventListener('click', refreshTicketsFromHalo);

function updateTabCounts() {
  $('#tab-tickets-count').textContent  = state.tickets.length;
  $('#tab-projects-count').textContent = state.projects.length;
}

function switchTab(name) {
  state.activeTab = name;
  for (const btn of $$('.tab-btn')) {
    btn.classList.toggle('active', btn.dataset.tab === name);
  }
  if (name === 'tickets') {
    show($('#tab-pane-tickets'));
    hide($('#tab-pane-projects'));
  } else {
    hide($('#tab-pane-tickets'));
    show($('#tab-pane-projects'));
  }
}
$$('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// ---- Tickets tab (flat list) ----

function renderTicketsTab() {
  const search = ($('#ticket-search').value || '').toLowerCase().trim();
  const filtered = state.tickets.filter(t => {
    if (!search) return true;
    return `${t.id} ${t.summary} ${t.client_name} ${t.site_name} ${t.status_name}`
      .toLowerCase().includes(search);
  });
  const container = $('#ticket-list');
  container.innerHTML = '';

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = state.tickets.length === 0
      ? 'No tickets assigned to you. Click "Refresh tickets" to check Halo.'
      : 'No matches for that search.';
    container.appendChild(empty);
    state.selectedTicketId = null;
    $('#start-btn').disabled = true;
    return;
  }

  // Drop selection if the chosen ticket is no longer visible; auto-pick the
  // first row otherwise so a quick search-then-Start works without a click.
  if (state.selectedTicketId && !filtered.some(t => t.id === state.selectedTicketId)) {
    state.selectedTicketId = null;
  }
  if (!state.selectedTicketId) {
    state.selectedTicketId = filtered[0].id;
  }

  for (const t of filtered) {
    const row = document.createElement('div');
    row.className = 'list-row';
    if (t.id === state.selectedTicketId) row.classList.add('selected');

    const main = document.createElement('div');
    main.className = 'list-row-main';

    const line = document.createElement('div');
    line.className = 'list-row-line';
    const idEl = document.createElement('span');
    idEl.className = 'list-row-id';
    idEl.textContent = `#${t.id}`;
    const sumEl = document.createElement('span');
    sumEl.className = 'list-row-summary';
    sumEl.textContent = t.summary;
    line.append(idEl, sumEl);
    main.appendChild(line);

    if (t.client_name) {
      const sub = document.createElement('div');
      sub.className = 'list-row-sub';
      sub.textContent = t.client_name;
      main.appendChild(sub);
    }
    row.appendChild(main);

    const pill = statusPill(t);
    if (pill) row.appendChild(pill);

    row.addEventListener('click', () => {
      state.selectedTicketId = t.id;
      for (const r of container.querySelectorAll('.list-row.selected')) {
        r.classList.remove('selected');
      }
      row.classList.add('selected');
      $('#start-btn').disabled = false;
    });
    row.addEventListener('dblclick', () => {
      state.selectedTicketId = t.id;
      $('#start-btn').click();
    });

    container.appendChild(row);
  }

  $('#start-btn').disabled = !state.selectedTicketId;
}

$('#ticket-search').addEventListener('input', renderTicketsTab);

$('#ticket-search').addEventListener('keydown', (evt) => {
  if (evt.key === 'Enter' && state.selectedTicketId) {
    evt.preventDefault();
    $('#start-btn').click();
  }
});

$('#start-btn').addEventListener('click', async () => {
  if (!state.selectedTicketId) return;
  const ticket = state.tickets.find(t => t.id === state.selectedTicketId);
  await callApi('startSession', { ticketId: state.selectedTicketId, ticketSummary: ticket?.summary });
  toast('Session started.', 'success');
  await loadRunning();
  await loadSessions();
});

// ---- Project Tasks tab (Customer → Parent Project → Tasks tree) ----

function buildProjectTree(tasks) {
  // Group by client, then by parent project. Tasks missing a parent fall
  // under a synthetic "Other tasks" pseudo-parent within their client.
  const byClient = new Map();
  for (const t of tasks) {
    const client = t.client_name || '(No client)';
    if (!byClient.has(client)) byClient.set(client, new Map());
    const parentKey = t.parent_project_id
      ? `p:${t.parent_project_id}`
      : 'other';
    const parentLabel = t.parent_project_id
      ? (t.parent_project_summary || `Project #${t.parent_project_id}`)
      : 'Other tasks';
    const parents = byClient.get(client);
    if (!parents.has(parentKey)) {
      parents.set(parentKey, {
        id: t.parent_project_id || null,
        label: parentLabel,
        tasks: [],
      });
    }
    parents.get(parentKey).tasks.push(t);
  }
  // Sort: clients alpha, parents alpha, tasks by id desc
  const clients = Array.from(byClient.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([client, parents]) => ({
      client,
      parents: Array.from(parents.values())
        .sort((a, b) => a.label.localeCompare(b.label))
        .map(p => ({ ...p, tasks: p.tasks.sort((a, b) => b.id - a.id) })),
    }));
  return clients;
}

function renderProjectsTab() {
  const search = ($('#project-search').value || '').toLowerCase().trim();
  const filtered = state.projects.filter(t => {
    if (!search) return true;
    return `${t.id} ${t.summary} ${t.client_name} ${t.parent_project_summary}`
      .toLowerCase().includes(search);
  });
  const container = $('#project-tree');
  container.innerHTML = '';

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.textContent = state.projects.length === 0
      ? 'No project tasks assigned to you. Click "Refresh tickets" to check Halo.'
      : 'No matches for that search.';
    container.appendChild(empty);
    state.selectedProjectTaskId = null;
    $('#start-projects-btn').disabled = true;
    return;
  }

  const tree = buildProjectTree(filtered);
  // If the previously-selected task is gone, clear it
  if (state.selectedProjectTaskId &&
      !filtered.some(t => t.id === state.selectedProjectTaskId)) {
    state.selectedProjectTaskId = null;
  }

  for (const group of tree) {
    const clientHeader = document.createElement('div');
    clientHeader.className = 'tree-client';
    clientHeader.textContent = group.client;
    container.appendChild(clientHeader);

    for (const parent of group.parents) {
      const parentRow = document.createElement('div');
      parentRow.className = 'tree-parent';
      const caret = document.createElement('span');
      caret.className = 'caret';
      caret.textContent = '▾';
      const label = document.createElement('span');
      label.textContent = parent.label;
      const idSpan = document.createElement('span');
      idSpan.className = 'parent-id';
      idSpan.textContent = parent.id ? `#${parent.id}` : '';
      parentRow.append(caret, label, idSpan);

      const childWrap = document.createElement('div');
      childWrap.className = 'tree-children';

      for (const task of parent.tasks) {
        const row = document.createElement('div');
        row.className = 'tree-task';
        if (task.id === state.selectedProjectTaskId) row.classList.add('selected');
        const idEl = document.createElement('span');
        idEl.className = 'task-id';
        idEl.textContent = `#${task.id}`;
        const sumEl = document.createElement('span');
        sumEl.className = 'task-summary';
        sumEl.textContent = task.summary;
        row.append(idEl, sumEl);
        const pill = statusPill(task);
        if (pill) row.appendChild(pill);

        row.addEventListener('click', () => {
          state.selectedProjectTaskId = task.id;
          $('#start-projects-btn').disabled = false;
          for (const r of container.querySelectorAll('.tree-task.selected')) {
            r.classList.remove('selected');
          }
          row.classList.add('selected');
        });
        row.addEventListener('dblclick', () => {
          state.selectedProjectTaskId = task.id;
          $('#start-projects-btn').click();
        });

        childWrap.appendChild(row);
      }

      parentRow.addEventListener('click', () => {
        parentRow.classList.toggle('collapsed');
        childWrap.classList.toggle('collapsed');
      });

      container.append(parentRow, childWrap);
    }
  }

  $('#start-projects-btn').disabled = !state.selectedProjectTaskId;
}

$('#project-search').addEventListener('input', renderProjectsTab);

$('#project-search').addEventListener('keydown', (evt) => {
  if (evt.key === 'Enter' && state.selectedProjectTaskId) {
    evt.preventDefault();
    $('#start-projects-btn').click();
  }
});

$('#start-projects-btn').addEventListener('click', async () => {
  if (!state.selectedProjectTaskId) return;
  const task = state.projects.find(t => t.id === state.selectedProjectTaskId);
  await callApi('startSession', { ticketId: state.selectedProjectTaskId, ticketSummary: task?.summary });
  toast('Session started.', 'success');
  await loadRunning();
  await loadSessions();
});

// ---------- timer ----------

async function loadRunning() {
  state.running = await callApi('getRunningSession');
  renderTimer();
}

function renderTimer() {
  if (state.running) {
    hide($('#timer-idle'));
    show($('#timer-running'));
    $('#running-ticket').textContent = `#${state.running.ticket_id} — ${state.running.ticket_summary}`;
    $('#running-started').textContent = fmtTime(state.running.start_at);
    tickRunning();
  } else {
    show($('#timer-idle'));
    hide($('#timer-running'));
  }
}

function tickRunning() {
  if (!state.running) return;
  $('#running-elapsed').textContent = fmtDuration(state.running.start_at, null);
}
setInterval(tickRunning, 1000);

$('#stop-btn').addEventListener('click', () => {
  if (!state.running) return;
  $('#stop-summary').textContent = `#${state.running.ticket_id} — ${state.running.ticket_summary}`;
  $('#stop-note').value = '';
  $('#stop-status').value = '';
  populateStatusDropdowns();
  show($('#stop-modal'));
  setTimeout(() => $('#stop-note').focus(), 50);
});

$('#stop-cancel').addEventListener('click', async () => {
  hide($('#stop-modal'));
  if (!state.running) return;
  await callApi('stopSession', { id: state.running.id, note: '' });
  await loadRunning();
  await loadSessions();
  await loadDailyTotals();
});

$('#stop-save').addEventListener('click', async () => {
  hide($('#stop-modal'));
  if (!state.running) return;
  const statusIdRaw = $('#stop-status').value;
  const statusId = statusIdRaw ? Number(statusIdRaw) : null;
  await callApi('stopSession', {
    id: state.running.id,
    note: $('#stop-note').value || '',
    statusId,
  });
  toast('Session saved locally. Push to Halo when ready.', 'success');
  await loadRunning();
  await loadSessions();
  await loadDailyTotals();
});

// ---------- sessions ----------

async function loadSessions() {
  state.sessions = await callApi('listSessions', { limit: 200, includeSynced: true });
  renderSessions();
}

function statusNameFor(id) {
  if (!id) return null;
  const s = state.statuses.find(s => s.id === Number(id));
  return s?.name || null;
}

function renderSessions() {
  const tbody = $('#sessions-body');
  tbody.innerHTML = '';
  const empty = $('#sessions-empty');

  if (state.sessions.length === 0) {
    show(empty);
    $('#unsynced-count').textContent = '';
    $('#push-all-btn').disabled = true;
    return;
  }
  hide(empty);

  let unsynced = 0;   // all not-yet-pushed, not-running (drives the badge count)
  let pushable = 0;   // unsynced AND has a ticket assigned (drives Push-all enable)
  for (const s of state.sessions) {
    const tr = document.createElement('tr');
    const isRunning = !s.end_at;
    const isSynced = !!s.synced_at;
    const unassigned = isUnassigned(s);
    if (isSynced) tr.classList.add('synced');
    if (unassigned) tr.classList.add('unassigned');
    if (!isSynced && !isRunning) {
      unsynced += 1;
      if (!unassigned) pushable += 1;
    }

    const ticketCell = document.createElement('td');
    ticketCell.className = 'ticket-cell';
    if (unassigned) {
      ticketCell.innerHTML = `
        <div class="unassigned-label">${escape(s.ticket_summary || '(unassigned)')}</div>
        <div class="ticket-id">no ticket — edit to assign</div>
      `;
    } else {
      ticketCell.innerHTML = `
        <div>${escape(s.ticket_summary)}</div>
        <div class="ticket-id">#${s.ticket_id}</div>
      `;
    }

    const startCell = document.createElement('td');
    startCell.textContent = fmtDateTime(s.start_at);

    const endCell = document.createElement('td');
    endCell.textContent = isRunning ? '—' : fmtDateTime(s.end_at);

    const durCell = document.createElement('td');
    durCell.textContent = isRunning ? 'running' : fmtHoursDecimal(s.start_at, s.end_at);

    const noteCell = document.createElement('td');
    noteCell.className = 'note-cell';
    const statusName = statusNameFor(s.status_id);
    if (s.note && statusName) {
      noteCell.innerHTML = `${escape(s.note)}<div class="ticket-id">→ set status: ${escape(statusName)}</div>`;
    } else if (statusName) {
      noteCell.innerHTML = `<span class="muted">(no note)</span><div class="ticket-id">→ set status: ${escape(statusName)}</div>`;
    } else {
      noteCell.textContent = s.note || '—';
    }

    const statusCell = document.createElement('td');
    if (isRunning) statusCell.innerHTML = '<span class="badge running">running</span>';
    else if (isSynced) statusCell.innerHTML = '<span class="badge synced">synced</span>';
    else if (unassigned) statusCell.innerHTML = '<span class="badge unassigned">unassigned</span>';
    else statusCell.innerHTML = '<span class="badge unsynced">local</span>';

    const actionsCell = document.createElement('td');
    actionsCell.className = 'actions-cell';
    if (!isRunning && !isSynced) {
      const editBtn = document.createElement('button');
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => openEditModal(s));
      const pushBtn = document.createElement('button');
      pushBtn.className = 'primary';
      pushBtn.textContent = 'Push';
      pushBtn.disabled = unassigned;
      if (unassigned) pushBtn.title = 'Assign a ticket number first (click Edit).';
      pushBtn.addEventListener('click', () => pushSession(s.id, pushBtn));
      const delBtn = document.createElement('button');
      delBtn.className = 'danger';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => deleteSession(s.id));
      actionsCell.append(editBtn, pushBtn, delBtn);
    } else if (isSynced && s.synced_action_id) {
      const idSpan = document.createElement('span');
      idSpan.className = 'ticket-id';
      idSpan.textContent = `Action #${s.synced_action_id}`;
      actionsCell.append(idSpan);
    }

    tr.append(ticketCell, startCell, endCell, durCell, noteCell, statusCell, actionsCell);
    tbody.appendChild(tr);
  }

  $('#unsynced-count').textContent = unsynced > 0 ? `${unsynced} unsynced` : 'All synced';
  $('#push-all-btn').disabled = pushable === 0;
}

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function pushSession(id, btn) {
  // Disable the calling Push button while the request is in flight so a
  // double-click can't create two actions. The backend has its own lock for
  // belt-and-suspenders coverage (e.g. from the Push-all path).
  if (btn) btn.disabled = true;
  try {
    const res = await callApi('pushSession', id);
    if (res.alreadySynced) {
      toast('Already synced.', '');
    } else if (res.statusWarning) {
      toast(`Pushed ${res.hours.toFixed(2)}h, but status update failed: ${res.statusWarning}`, 'error');
    } else {
      toast(`Pushed ${res.hours.toFixed(2)}h to Halo.`, 'success');
    }
    await loadSessions();
    await loadDailyTotals();
  } catch (_) {
    // error toast already shown — re-enable so the user can retry
    if (btn) btn.disabled = false;
  }
}

async function deleteSession(id) {
  if (!confirm('Delete this session? This cannot be undone.')) return;
  await callApi('deleteSession', id);
  await loadSessions();
  await loadDailyTotals();
}

$('#push-all-btn').addEventListener('click', async () => {
  const btn = $('#push-all-btn');
  btn.disabled = true; const original = btn.textContent; btn.textContent = 'Pushing…';
  try {
    const results = await callApi('pushAllUnsynced');
    const ok = results.filter(r => r.ok).length;
    const fail = results.length - ok;
    const warns = results.filter(r => r.ok && r.statusWarning).length;
    if (fail === 0 && warns === 0) {
      toast(`Pushed ${ok} session${ok === 1 ? '' : 's'} to Halo.`, 'success');
    } else if (fail === 0) {
      toast(`Pushed ${ok}, but ${warns} status update${warns === 1 ? '' : 's'} failed.`, 'error');
    } else if (warns === 0) {
      toast(`Pushed ${ok}, ${fail} failed.`, 'error');
    } else {
      toast(`Pushed ${ok} (${warns} status update${warns === 1 ? '' : 's'} failed), ${fail} skipped.`, 'error');
    }
    await loadSessions();
    await loadDailyTotals();
  } catch (_) { /* error toast already shown */ }
  finally {
    btn.textContent = original;
  }
});

// ---------- edit modal ----------

function openEditModal(session) {
  $('#edit-id').value = session.id;
  // Empty for unassigned (ticket_id=0) so the placeholder shows through.
  $('#edit-ticket-id').value = session.ticket_id ? String(session.ticket_id) : '';
  $('#edit-start').value = isoToLocalDatetimeInput(session.start_at);
  $('#edit-end').value   = isoToLocalDatetimeInput(session.end_at);
  $('#edit-note').value  = session.note || '';
  populateStatusDropdowns();
  $('#edit-status').value = session.status_id ? String(session.status_id) : '';
  $('#edit-error').textContent = '';
  // Only show the explanatory hint for unassigned (quick-logged) sessions —
  // it's clutter when editing an already-ticketed session.
  const hint = $('#edit-ticket-hint');
  if (hint) hint.style.display = isUnassigned(session) ? '' : 'none';
  show($('#edit-modal'));
}

$('#edit-cancel').addEventListener('click', () => hide($('#edit-modal')));

$('#edit-save').addEventListener('click', async () => {
  const id = Number($('#edit-id').value);
  const startAt = localDatetimeInputToIso($('#edit-start').value);
  const endAt   = localDatetimeInputToIso($('#edit-end').value);
  const note    = $('#edit-note').value;
  const statusIdRaw = $('#edit-status').value;
  const statusId = statusIdRaw ? Number(statusIdRaw) : null;
  const ticketIdRaw = $('#edit-ticket-id').value.trim();

  if (!startAt || !endAt) {
    $('#edit-error').textContent = 'Start and end are required.';
    return;
  }
  if (new Date(endAt) <= new Date(startAt)) {
    $('#edit-error').textContent = 'End must be after start.';
    return;
  }

  // Validate the ticket ID. Blank = leave unassigned (the session stays
  // un-pushable). A typed value must be a positive integer; look up a
  // friendly summary if we know the ticket, otherwise stamp a placeholder.
  let ticketId;
  let ticketSummary;
  if (ticketIdRaw === '') {
    ticketId = 0;
    ticketSummary = '(quick log — assign ticket before pushing)';
  } else {
    const n = Number(ticketIdRaw);
    if (!Number.isInteger(n) || n <= 0) {
      $('#edit-error').textContent = 'Ticket number must be a positive whole number.';
      return;
    }
    ticketId = n;
    const known =
      state.tickets.find(t => t.id === n) ||
      state.projects.find(t => t.id === n);
    ticketSummary = known?.summary || `Ticket #${n}`;
  }

  try {
    await callApi('updateSession', {
      id, startAt, endAt, note, statusId, ticketId, ticketSummary,
    });
    hide($('#edit-modal'));
    await loadSessions();
    await loadDailyTotals();
    toast('Session updated.', 'success');
  } catch (_) { /* toast already */ }
});

// ---------- daily totals ----------

async function loadDailyTotals() {
  const rows = await callApi('dailyTotals', { days: 7 });
  const container = $('#daily-totals');
  container.innerHTML = '';

  const byDay = new Map(rows.map(r => [r.day, r]));
  const pad = (n) => String(n).padStart(2, '0');
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    // Bucket key must be the *local* calendar date — toISOString() gives UTC,
    // which skews evenings into the next day's bucket. Backend uses the same
    // local-date convention.
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const row = byDay.get(key) || { hours: 0, sessions: 0 };
    const card = document.createElement('div');
    card.className = 'day-card';
    const dayName = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    card.innerHTML = `
      <div class="day-name">${dayName}</div>
      <div class="day-hours">${(row.hours || 0).toFixed(2)}h</div>
      <div class="day-sessions">${row.sessions || 0} session${row.sessions === 1 ? '' : 's'}</div>
    `;
    container.appendChild(card);
  }
}

// ---------- weekly summary ----------

async function loadWeeklySummary() {
  await Promise.all([loadWeeklyTotals(), loadHoursByClient()]);
}

// "YYYY-MM-DD" → local Date (avoids the UTC-shift you get from `new Date(str)`).
function parseLocalDate(ymd) {
  if (!ymd) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

async function loadWeeklyTotals() {
  const rows = await callApi('weeklyTotals', { weeks: 8 });
  const tbody = $('#weekly-body');
  const empty = $('#weekly-empty');
  tbody.innerHTML = '';
  if (!rows || rows.length === 0) {
    show(empty);
    return;
  }
  hide(empty);
  for (const r of rows) {
    const tr = document.createElement('tr');
    const d = parseLocalDate(r.week_start);
    const weekLabel = d
      ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : (r.week_start || '—');
    tr.innerHTML = `
      <td>${escape(weekLabel)}</td>
      <td>${r.sessions || 0}</td>
      <td>${(r.hours || 0).toFixed(2)}h</td>
    `;
    tbody.appendChild(tr);
  }
}

async function loadHoursByClient() {
  const rows = await callApi('hoursByClient', { days: 30 });
  const tbody = $('#client-hours-body');
  const empty = $('#client-hours-empty');
  tbody.innerHTML = '';
  if (!rows || rows.length === 0) {
    show(empty);
    return;
  }
  hide(empty);
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escape(r.client_name || '(unassigned)')}</td>
      <td>${r.sessions || 0}</td>
      <td>${(r.hours || 0).toFixed(2)}h</td>
    `;
    tbody.appendChild(tr);
  }
}

// ---------- preferences ----------

async function loadPrefs() {
  state.prefs = await callApi('getPrefs');
  applyQuickLogButtonLabels();
}

// Quick-log buttons show whatever the user configured in prefs — minute label
// and (if set) the hotkey accelerator in the tooltip.
function applyQuickLogButtonLabels() {
  const minutes = state.prefs?.quickLogMinutes || [5, 10, 15];
  const hotkeys = state.prefs?.hotkeys || {};
  const buttons = $$('#quick-log-bar .quick-log-btn');
  buttons.forEach((btn, i) => {
    const m = minutes[i];
    if (!Number.isFinite(m)) return;
    btn.dataset.minutes = String(m);
    btn.textContent = `+${m} min`;
    const accel = hotkeys[`quickLog${i + 1}`] || '';
    btn.title = accel || '';
  });
}

async function showSettingsModal() {
  // Populate the Connection fieldset from whatever status we last saw.
  renderConnectedPanel();

  const p = state.prefs || {};
  $('#pref-idle-enabled').checked  = !!p.idleAutoPauseEnabled;
  $('#pref-idle-minutes').value    = p.idleThresholdMinutes ?? 5;
  $('#pref-nudge-enabled').checked = !!p.nudgeEnabled;
  $('#pref-nudge-minutes').value   = p.nudgeIntervalMinutes ?? 30;
  $('#pref-work-start').value      = p.workHoursStart || '09:00';
  $('#pref-work-end').value        = p.workHoursEnd   || '17:00';
  const days = new Set(String(p.workDays || '1,2,3,4,5').split(',').map(s => s.trim()).filter(Boolean));
  $$('#settings-modal input[data-weekday]').forEach(el => {
    el.checked = days.has(el.dataset.weekday);
  });

  // Quick-log durations
  const ql = Array.isArray(p.quickLogMinutes) ? p.quickLogMinutes : [5, 10, 15];
  $('#pref-quick-1').value = ql[0] ?? 5;
  $('#pref-quick-2').value = ql[1] ?? 10;
  $('#pref-quick-3').value = ql[2] ?? 15;

  // Hotkeys — render the current accelerator into each button's label
  _pendingHotkeys = { ...(p.hotkeys || {}) };
  refreshHotkeyButtons();

  try {
    const al = await callApi('getAutoLaunch');
    state.autoLaunch = !!al.enabled;
    $('#pref-autolaunch').checked = state.autoLaunch;
  } catch (_) {
    $('#pref-autolaunch').checked = false;
  }

  await populateAboutSection();

  $('#settings-modal-error').textContent = '';
  show($('#settings-modal'));
}

// Cached app info so we don't re-hit IPC every time the modal opens.
let _appInfo = null;

async function populateAboutSection() {
  try {
    if (!_appInfo) _appInfo = await callApi('getAppInfo');
    $('#about-version').textContent = `${_appInfo.version}${_appInfo.isPackaged ? '' : ' (dev)'}`;
  } catch (_) {
    $('#about-version').textContent = 'unknown';
  }
  // Leave the status line alone if we already received a live update from main;
  // only reset it when the user re-opens the modal cold.
  if (!_lastUpdateStatusAt) {
    $('#about-update-status').textContent = 'Not checked yet.';
  }
}

let _lastUpdateStatusAt = null;

window.api.onUpdateStatus((payload) => {
  _lastUpdateStatusAt = payload?.at || new Date().toISOString();
  const el = document.getElementById('about-update-status');
  if (el) el.textContent = payload?.message || '';
});

$('#about-check-updates').addEventListener('click', async () => {
  const btn = $('#about-check-updates');
  btn.disabled = true;
  $('#about-update-status').textContent = 'Checking for updates…';
  try {
    const res = await callApi('checkForUpdates');
    if (res.skipped) {
      // Dev builds — no installer to compare against. Be explicit.
      $('#about-update-status').textContent = res.reason || 'Update checks are only available in packaged builds.';
    } else if (res.updateVersion && res.updateVersion !== res.currentVersion) {
      $('#about-update-status').textContent = `Version ${res.updateVersion} available — downloading in the background.`;
    } else {
      $('#about-update-status').textContent = "You're on the latest version.";
    }
  } catch (_) { /* toast already shown */ }
  finally { btn.disabled = false; }
});

$('#about-release-notes').addEventListener('click', () => {
  callApi('openReleaseNotes').catch(() => {});
});

$('#about-open-logs').addEventListener('click', () => {
  callApi('openLogFolder').catch(() => {});
});

$('#about-open-backups').addEventListener('click', () => {
  callApi('openBackupFolder').catch(() => {});
});

// ---------- restore from backup ----------

function fmtBackupSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtBackupTime(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return d.toLocaleString([], {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

async function openRestoreModal() {
  $('#restore-modal').classList.remove('hidden');
  $('#restore-error').textContent = '';
  const listEl = $('#restore-list');
  listEl.innerHTML = '<p class="muted" id="restore-empty">Loading backups…</p>';
  try {
    const data = await callApi('listBackups');
    const backups = data?.backups || [];
    if (backups.length === 0) {
      listEl.innerHTML = '<p class="muted">No backup snapshots found yet. They\'re written automatically while the app is running.</p>';
      return;
    }
    listEl.innerHTML = '';
    for (const b of backups) {
      const row = document.createElement('div');
      row.className = 'restore-row';
      const meta = document.createElement('div');
      meta.className = 'restore-meta';
      const name = document.createElement('strong');
      name.textContent = b.name;
      const sub = document.createElement('span');
      sub.className = 'muted';
      sub.textContent = `${fmtBackupTime(b.mtime)} · ${fmtBackupSize(b.size)}`;
      meta.appendChild(name);
      meta.appendChild(sub);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'primary';
      btn.textContent = 'Restore';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        $('#restore-error').textContent = '';
        try {
          const res = await callApi('restoreBackup', b.name);
          if (res && res.confirmed === false) {
            btn.disabled = false; // user cancelled the native dialog
          }
          // On confirm, the main process is restarting — nothing else to do here.
        } catch (err) {
          $('#restore-error').textContent = err.message || String(err);
          btn.disabled = false;
        }
      });
      row.appendChild(meta);
      row.appendChild(btn);
      listEl.appendChild(row);
    }
  } catch (err) {
    listEl.innerHTML = '';
    $('#restore-error').textContent = err.message || String(err);
  }
}

$('#about-restore-backup').addEventListener('click', openRestoreModal);

$('#restore-cancel').addEventListener('click', () => {
  $('#restore-modal').classList.add('hidden');
});

// ---------- hotkey capture ----------

// Working copy of the hotkey accelerators while the Settings modal is open.
// Committed to prefs on save, discarded on cancel.
let _pendingHotkeys = {};
let _recordingHotkey = null;

const HOTKEY_FIELDS = ['showApp', 'quickLog1', 'quickLog2', 'quickLog3'];
const HOTKEY_MODIFIERS = new Set(['Control', 'Ctrl', 'Alt', 'Shift', 'Super', 'Meta', 'Command', 'Cmd', 'CommandOrControl', 'CmdOrCtrl', 'Option', 'AltGr']);

function refreshHotkeyButtons() {
  for (const field of HOTKEY_FIELDS) {
    const btn = document.querySelector(`.hotkey-btn[data-hotkey="${field}"]`);
    if (!btn) continue;
    btn.classList.toggle('recording', _recordingHotkey === field);
    if (_recordingHotkey === field) {
      btn.textContent = 'Press keys… (Esc to cancel)';
    } else {
      btn.textContent = _pendingHotkeys[field] || '(disabled)';
    }
  }
}

// Translate a KeyboardEvent into an Electron accelerator. Returns null if the
// key combo is incomplete (e.g. user just pressed a modifier on its own).
function eventToAccelerator(evt) {
  const parts = [];
  if (evt.ctrlKey)  parts.push('Control');
  if (evt.altKey)   parts.push('Alt');
  if (evt.shiftKey) parts.push('Shift');
  if (evt.metaKey)  parts.push('Super');
  const rawKey = evt.key;
  if (!rawKey || HOTKEY_MODIFIERS.has(rawKey)) return null;
  // Normalise common key names to Electron's accelerator format
  let key;
  if (rawKey === ' ') key = 'Space';
  else if (rawKey.length === 1) key = rawKey.toUpperCase();
  else if (/^F\d{1,2}$/.test(rawKey)) key = rawKey;
  else if (rawKey === 'ArrowUp')    key = 'Up';
  else if (rawKey === 'ArrowDown')  key = 'Down';
  else if (rawKey === 'ArrowLeft')  key = 'Left';
  else if (rawKey === 'ArrowRight') key = 'Right';
  else key = rawKey;
  parts.push(key);
  if (parts.length < 2) return null;
  return parts.join('+');
}

function startRecordingHotkey(field) {
  _recordingHotkey = field;
  refreshHotkeyButtons();
}

function stopRecordingHotkey() {
  _recordingHotkey = null;
  refreshHotkeyButtons();
}

$$('.hotkey-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const field = btn.dataset.hotkey;
    if (!field) return;
    if (_recordingHotkey === field) stopRecordingHotkey();
    else startRecordingHotkey(field);
  });
});

$$('.hotkey-clear').forEach(btn => {
  btn.addEventListener('click', () => {
    const field = btn.dataset.hotkeyClear;
    if (!field) return;
    _pendingHotkeys[field] = '';
    if (_recordingHotkey === field) stopRecordingHotkey();
    else refreshHotkeyButtons();
  });
});

// Capture key combos at the window level when a hotkey button is "recording".
// Use capture phase so the keydown listener that closes modals on Esc doesn't
// preempt a cancel-recording press.
window.addEventListener('keydown', (evt) => {
  if (!_recordingHotkey) return;
  if (evt.key === 'Escape') {
    evt.preventDefault();
    evt.stopPropagation();
    stopRecordingHotkey();
    return;
  }
  if (HOTKEY_MODIFIERS.has(evt.key)) return; // wait for the non-modifier key
  evt.preventDefault();
  evt.stopPropagation();
  const accel = eventToAccelerator(evt);
  if (!accel) return;
  _pendingHotkeys[_recordingHotkey] = accel;
  stopRecordingHotkey();
}, true);

$('#settings-modal-cancel').addEventListener('click', () => {
  stopRecordingHotkey();
  hide($('#settings-modal'));
});

$('#settings-modal-save').addEventListener('click', async () => {
  const days = $$('#settings-modal input[data-weekday]')
    .filter(el => el.checked)
    .map(el => el.dataset.weekday)
    .join(',');

  const quickLogMinutes = [
    Number($('#pref-quick-1').value),
    Number($('#pref-quick-2').value),
    Number($('#pref-quick-3').value),
  ];

  const payload = {
    idleAutoPauseEnabled: $('#pref-idle-enabled').checked,
    idleThresholdMinutes: Number($('#pref-idle-minutes').value) || 5,
    nudgeEnabled:         $('#pref-nudge-enabled').checked,
    nudgeIntervalMinutes: Number($('#pref-nudge-minutes').value) || 30,
    workHoursStart:       $('#pref-work-start').value || '09:00',
    workHoursEnd:         $('#pref-work-end').value   || '17:00',
    workDays:             days,
    quickLogMinutes,
    hotkeys:              { ..._pendingHotkeys },
  };

  if (payload.idleThresholdMinutes < 1 || payload.idleThresholdMinutes > 240) {
    $('#settings-modal-error').textContent = 'Idle threshold must be between 1 and 240 minutes.';
    return;
  }
  if (payload.nudgeIntervalMinutes < 5 || payload.nudgeIntervalMinutes > 240) {
    $('#settings-modal-error').textContent = 'Nudge interval must be between 5 and 240 minutes.';
    return;
  }
  if (payload.workHoursEnd <= payload.workHoursStart) {
    $('#settings-modal-error').textContent = 'Work hours end must be after start.';
    return;
  }
  for (const m of quickLogMinutes) {
    if (!Number.isInteger(m) || m < 1 || m > 480) {
      $('#settings-modal-error').textContent = 'Quick-log durations must be whole numbers between 1 and 480 minutes.';
      return;
    }
  }

  try {
    state.prefs = await callApi('savePrefs', payload);

    const wantAutoLaunch = $('#pref-autolaunch').checked;
    if (wantAutoLaunch !== state.autoLaunch) {
      const al = await callApi('setAutoLaunch', wantAutoLaunch);
      state.autoLaunch = !!al.enabled;
    }

    // Re-render the quick-log buttons with the new minute labels & tooltips.
    applyQuickLogButtonLabels();
    stopRecordingHotkey();
    hide($('#settings-modal'));
    toast('Settings saved.', 'success');
  } catch (_) { /* toast already shown */ }
});

// ---------- quick log ----------

// Quick-logs are always unassigned (ticket_id=0). The user assigns a real
// ticket number in the Edit modal before pushing. This matches the "Level 1
// walks over for help on a ticket I'm not the agent on" workflow.
$$('#quick-log-bar .quick-log-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const minutes = Number(btn.dataset.minutes);
    btn.disabled = true;
    try {
      const res = await callApi('quickLog', { minutes });
      toast(`Logged ${res.minutes} min — edit the session to assign a ticket before pushing.`, 'success');
      await loadSessions();
      await loadDailyTotals();
    } catch (_) { /* toast already shown */ }
    finally { btn.disabled = false; }
  });
});

// ---------- hotkey events from main ----------

window.api.onFocusSearch(() => {
  const search = state.activeTab === 'projects' ? $('#project-search') : $('#ticket-search');
  search.focus();
  search.select();
});

window.api.onQuickLogged(async (info) => {
  // The global hotkey already inserted the unassigned row; refresh the log
  // so it shows up, and remind the user to assign a ticket before pushing.
  await loadSessions();
  await loadDailyTotals();
  if (info) {
    toast(`Logged ${info.minutes} min — edit the session to assign a ticket before pushing.`, 'success');
  }
});

// ---------- session changed (e.g. nudge popup started a timer) ----------

window.api.onSessionChanged(async () => {
  await loadRunning();
  await loadSessions();
  await loadDailyTotals();
});

// ---------- tray menu actions ----------

window.api.onTrayStopTimer(() => {
  // Mirror what the in-app Stop button does: open the modal pre-populated for
  // the running session. Bail out quietly if nothing is actually running.
  if (!state.running) return;
  $('#stop-btn').click();
});

window.api.onTrayOpenSettings(() => {
  // Tray's "Settings…" item just routes through the same handler the topbar
  // button uses — keeps the entry point single-sourced.
  $('#open-settings').click();
});

// ---------- idle auto-pause ----------

window.api.onIdleAutoPaused(async (info) => {
  await loadRunning();
  await loadSessions();
  await loadDailyTotals();

  const ticket = info?.ticketSummary ? `"${info.ticketSummary}"` : 'your session';
  let reason;
  switch (info?.reason) {
    case 'suspend':     reason = 'computer went to sleep'; break;
    case 'lock-screen': reason = 'screen was locked'; break;
    case 'shutdown':    reason = 'computer shut down'; break;
    case 'idle':
    default:            reason = `${info?.idleMinutes || 'a few'} minutes of inactivity`; break;
  }
  toast(`Auto-stopped ${ticket} — ${reason}.`, 'success');
});

// ---------- init ----------

document.addEventListener('keydown', (evt) => {
  if (evt.key === 'Escape') {
    hide($('#stop-modal'));
    hide($('#edit-modal'));
    hide($('#settings-modal'));
  }
});

boot().catch((err) => {
  console.error(err);
  toast('Failed to start: ' + err.message, 'error');
});
