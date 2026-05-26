'use strict';

const $ = (sel) => document.querySelector(sel);

const state = {
  mode: 'in-hours', // or 'after-hours'
  tickets: [],
  selectedTicketId: null,
  nextWorkPeriodLabel: '',
};

// ---------- bootstrap ----------

async function init() {
  // Ask the main process what kind of nudge this is
  try {
    const ctx = await callApi('getNudgeContext');
    if (ctx) {
      state.mode = ctx.mode || 'in-hours';
      state.nextWorkPeriodLabel = ctx.nextWorkPeriodLabel || '';
    }
  } catch (_) { /* fall back to in-hours defaults */ }

  applyMode();
}

function applyMode() {
  if (state.mode === 'after-hours') {
    $('#nudge-title').textContent = 'Still working?';
    const detail = state.nextWorkPeriodLabel
      ? `Your workday has ended. If you're still working on something, start a timer — otherwise, snooze until ${state.nextWorkPeriodLabel}.`
      : `Your workday has ended. If you're still working on something, start a timer.`;
    $('#nudge-message').textContent = detail;

    // Reveal the "until next work period" option
    const nextOpt = $('#snooze-next-period');
    nextOpt.hidden = false;
    if (state.nextWorkPeriodLabel) {
      nextOpt.textContent = `Until ${state.nextWorkPeriodLabel}`;
    }
    // Default to that option after hours
    $('#snooze-select').value = 'next-period';
  } else {
    $('#nudge-title').textContent = 'No timer running';
    $('#nudge-message').textContent = "You're in work hours but no timer is running. Want to start tracking?";
    $('#snooze-next-period').hidden = true;
    $('#snooze-select').value = '60';
  }
}

// ---------- snooze ----------

$('#snooze-btn').addEventListener('click', async () => {
  const value = $('#snooze-select').value;
  await window.api.snoozeNudge(value);
  // Main process closes the window when snooze is accepted
});

// ---------- ticket picker ----------

$('#show-picker').addEventListener('click', async () => {
  $('#nudge-view').classList.add('hidden');
  $('#picker-view').classList.add('active');

  try {
    const tickets = await callApi('listTickets');
    state.tickets = tickets || [];
    renderTickets();
    setTimeout(() => $('#ticket-search').focus(), 50);
  } catch (err) {
    showPickerError(err.message);
  }
});

$('#picker-back').addEventListener('click', () => {
  $('#picker-view').classList.remove('active');
  $('#nudge-view').classList.remove('hidden');
});

$('#ticket-search').addEventListener('input', renderTickets);

$('#ticket-list').addEventListener('change', (evt) => {
  state.selectedTicketId = Number(evt.target.value) || null;
  $('#picker-start').disabled = !state.selectedTicketId;
});

$('#ticket-list').addEventListener('dblclick', () => $('#picker-start').click());

$('#picker-start').addEventListener('click', async () => {
  if (!state.selectedTicketId) return;
  const ticket = state.tickets.find(t => t.id === state.selectedTicketId);
  const btn = $('#picker-start');
  btn.disabled = true;
  btn.textContent = 'Starting…';
  try {
    await callApi('startSession', {
      ticketId: state.selectedTicketId,
      ticketSummary: ticket?.summary,
    });
    // Main process closes the popup once the session starts
    await window.api.nudgeStarted();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Start tracking';
    showPickerError(err.message);
  }
});

function renderTickets() {
  const search = ($('#ticket-search').value || '').toLowerCase().trim();
  const select = $('#ticket-list');
  const filtered = state.tickets.filter(t => {
    if (!search) return true;
    return `${t.id} ${t.summary} ${t.client_name || ''} ${t.site_name || ''}`.toLowerCase().includes(search);
  });
  select.innerHTML = '';
  for (const t of filtered) {
    const opt = document.createElement('option');
    opt.value = String(t.id);
    const tag = t.is_project ? '[Project] ' : '';
    const clientPart = t.client_name ? ` · ${t.client_name}` : '';
    opt.textContent = `${tag}#${t.id} — ${t.summary}${clientPart}`;
    select.appendChild(opt);
  }
  if (filtered.length === 0) {
    const opt = document.createElement('option');
    opt.disabled = true;
    opt.textContent = '— No tickets match —';
    select.appendChild(opt);
  }
  if (state.selectedTicketId && filtered.some(t => t.id === state.selectedTicketId)) {
    select.value = String(state.selectedTicketId);
  } else {
    state.selectedTicketId = filtered[0]?.id || null;
    if (state.selectedTicketId) select.value = String(state.selectedTicketId);
  }
  $('#picker-start').disabled = !state.selectedTicketId;
}

function showPickerError(msg) {
  // Reuse the ticket list area to surface an error
  const select = $('#ticket-list');
  select.innerHTML = '';
  const opt = document.createElement('option');
  opt.disabled = true;
  opt.textContent = msg || 'Something went wrong';
  select.appendChild(opt);
}

async function callApi(name, ...args) {
  const res = await window.api[name](...args);
  if (!res || !res.ok) {
    throw new Error(res?.error || 'Unknown error');
  }
  return res.data;
}

init();
