'use strict';

class HaloClient {
  constructor({ baseUrl, clientId, clientSecret, scope = 'all' }) {
    if (!baseUrl) throw new Error('baseUrl is required');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.scope = scope;
    this._token = null;
    this._tokenExpiresAt = 0;
  }

  async _getToken() {
    const now = Date.now();
    if (this._token && now < this._tokenExpiresAt - 30_000) return this._token;

    const url = `${this.baseUrl}/auth/token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: this.scope,
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Halo auth failed (${res.status}): ${text || res.statusText}`);
    }

    const data = await res.json();
    if (!data.access_token) throw new Error('Halo auth response missing access_token');

    this._token = data.access_token;
    const expiresInMs = (Number(data.expires_in) || 3600) * 1000;
    this._tokenExpiresAt = now + expiresInMs;
    return this._token;
  }

  async _request(method, path, { query, body } = {}) {
    const token = await this._getToken();
    const url = new URL(`${this.baseUrl}/api${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        url.searchParams.append(k, String(v));
      }
    }

    const init = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url.toString(), init);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Halo ${method} ${path} failed (${res.status}): ${text || res.statusText}`);
    }
    if (res.status === 204) return null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return res.text();
  }

  // ----- public API -----

  async testConnection() {
    await this._getToken();
    return true;
  }

  /**
   * Find the agent ID matching an email address. Halo's /Agent endpoint
   * supports search but case sensitivity varies, so we paginate and match.
   */
  async findAgentIdByEmail(email) {
    const target = (email || '').trim().toLowerCase();
    if (!target) throw new Error('email is required');

    let pageNo = 1;
    const pageSize = 100;
    while (pageNo < 50) {
      const data = await this._request('GET', '/Agent', {
        query: { page_no: pageNo, page_size: pageSize, includeenabled: true },
      });
      const list = data?.agents || data || [];
      if (!Array.isArray(list) || list.length === 0) return null;
      for (const a of list) {
        const e = (a.email || a.emailaddress || '').toLowerCase();
        if (e === target) return a.id;
      }
      if (list.length < pageSize) return null;
      pageNo += 1;
    }
    return null;
  }

  /**
   * List open tickets assigned to a given agent. If includeProjects is true,
   * project-domain tickets are included; otherwise only standard requests.
   */
  async listMyTickets({ agentId, includeProjects = true, pageSize = 100 }) {
    if (!agentId) throw new Error('agentId is required');
    const out = [];
    const domains = includeProjects ? [undefined, 'prjs'] : [undefined];

    for (const domain of domains) {
      let pageNo = 1;
      while (pageNo < 50) {
        const query = {
          agent_id: agentId,
          open_only: true,
          includeagent: true,
          includedetails: true,
          includeinactiveusers: 0,
          page_no: pageNo,
          page_size: pageSize,
          orderby: 'id',
          orderbydesc: true,
        };
        if (domain) query.domain = domain;

        const data = await this._request('GET', '/Tickets', { query });
        const list = data?.tickets || data?.faults || data || [];
        if (!Array.isArray(list) || list.length === 0) break;
        for (const t of list) out.push(this._normalizeTicket(t, domain));
        if (list.length < pageSize) break;
        pageNo += 1;
      }
    }

    // Dedupe by id (the same ticket could appear across domains in edge cases)
    const seen = new Map();
    for (const t of out) seen.set(t.id, t);
    const tickets = Array.from(seen.values());

    // Enrich any project tasks whose parent project summary didn't come back
    // in the /Tickets listing. Halo often omits parent-ticket details from the
    // list payload, so we look each parent up individually. Failures are
    // silently swallowed — the UI falls back to "Project #N" in that case.
    if (includeProjects) {
      const needed = new Set();
      for (const t of tickets) {
        if (t.is_project && t.parent_project_id && !t.parent_project_summary) {
          needed.add(t.parent_project_id);
        }
      }
      const fetched = new Map();
      for (const parentId of needed) {
        try {
          const parent = await this._request('GET', `/Tickets/${parentId}`);
          const summary = parent?.summary || parent?.name || '';
          if (summary) fetched.set(parentId, summary);
        } catch (_) { /* fall back to "Project #N" */ }
      }
      if (fetched.size > 0) {
        for (const t of tickets) {
          if (t.is_project && !t.parent_project_summary && fetched.has(t.parent_project_id)) {
            t.parent_project_summary = fetched.get(t.parent_project_id);
          }
        }
      }
    }

    return tickets;
  }

  _normalizeTicket(t, domain) {
    // Halo's response shape varies a lot across versions, tenants, and
    // ticket domains. Try a broad set of field name conventions — flat
    // (snake_case + smushed), nested objects, and customer/company variants.
    const pick = (...keys) => {
      for (const k of keys) {
        const v = k.includes('.')
          ? k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), t)
          : t[k];
        if (v !== undefined && v !== null && v !== '') return v;
      }
      return '';
    };

    const parentId =
      t.project_id ?? t.projectid ??
      t.projecticket_id ?? t.projectticket_id ?? t.projecticketid ??
      t.parent_id ?? t.parentid ??
      t.parentticket_id ?? t.parentticketid ??
      t.project?.id ?? t.parent?.id ?? t.projecticket?.id ??
      null;

    const parentSummary = pick(
      'project_name', 'projectname',
      'project_summary', 'projectsummary',
      'project.summary', 'project.name',
      'projecticketname', 'projecticket_summary', 'projecticketsummary',
      'projecticket.summary', 'projecticket.name',
      'parent_summary', 'parentsummary',
      'parent_name', 'parentname',
      'parent.summary', 'parent.name'
    );

    const clientName = pick(
      'client_name', 'clientname',
      'customer_name', 'customername',
      'customer_summary', 'customersummary',
      'client.name', 'client.clientname',
      'customer.name', 'customer.summary',
      'company_name', 'companyname',
      'company.name'
    );

    const statusId =
      t.status_id ?? t.statusid ?? t.status?.id ?? null;

    return {
      id: t.id,
      summary: t.summary || t.name || '(no summary)',
      client_name: clientName,
      site_name: pick('site_name', 'sitename', 'site.name'),
      status_id: statusId != null ? Number(statusId) : null,
      status_name: pick('status_name', 'statusname', 'status.name', 'status.statusname'),
      type_name: pick('tickettype_name', 'tickettypename', 'tickettype.name', 'type.name'),
      is_project: domain === 'prjs',
      parent_project_id: parentId ? Number(parentId) : null,
      parent_project_summary: parentSummary || '',
      raw: undefined,
    };
  }

  /**
   * Fetch the list of ticket statuses configured in this Halo tenant.
   * Returns an array of { id, name, isClosed } objects.
   */
  async getStatuses() {
    const data = await this._request('GET', '/Status', {
      query: { showall: true, showcounts: false },
    });
    const list = data?.statuses || data || [];
    if (!Array.isArray(list)) return [];
    return list.map(s => ({
      id: Number(s.id),
      name: s.name || s.statusname || `Status #${s.id}`,
      colour: normalizeColour(s.colour ?? s.color),
      isClosed: !!(s.isclosed ?? s.isClosed ?? s.closed),
    })).filter(s => Number.isFinite(s.id));
  }

  /**
   * Push a single time entry / note to a ticket as a HaloPSA Action.
   * - note: string body of the note
   * - timeTakenHours: decimal hours (e.g. 0.5 for 30 min)
   * - occurredAt: Date object — when the work was done (sets the action datetime)
   * - isPrivate: if true, marks the note as a private/internal note
   * - statusId: optional — when provided, the ticket's status is updated via
   *   a separate POST /Tickets call after the action is created. We tried
   *   piggybacking the status onto the action body (Halo's "Ticket Change
   *   Fields"), but that doesn't reliably apply in v2 — the action lands
   *   but the status doesn't move. The two-step approach is slower but
   *   actually works.
   *
   * Returns { action, statusWarning } — statusWarning is non-null when the
   * action succeeded but the follow-up status update failed. Callers can
   * still mark the session synced and surface the warning to the user.
   */
  async postTicketAction({ ticketId, note, timeTakenHours, occurredAt, isPrivate = true, statusId = null }) {
    if (!ticketId) throw new Error('ticketId is required');
    const action = {
      ticket_id: ticketId,
      outcome: 'Private Note',
      note: note || '',
      hiddenfromuser: !!isPrivate,
      timetaken: Number(timeTakenHours.toFixed(4)),
      datetime: occurredAt instanceof Date ? occurredAt.toISOString() : new Date().toISOString(),
    };
    const created = await this._request('POST', '/Actions', { body: [action] });
    const createdAction = Array.isArray(created) ? (created[0] || null) : created;

    let statusWarning = null;
    if (statusId) {
      try {
        await this._request('POST', '/Tickets', {
          body: [{ id: Number(ticketId), status_id: Number(statusId) }],
        });
      } catch (err) {
        statusWarning = err.message || String(err);
      }
    }

    return { action: createdAction, statusWarning };
  }
}

/**
 * Normalize a Halo status colour value into a "#rrggbb" string, or null.
 * Halo returns colours in a few shapes: bare hex ("3FA9F5"), prefixed
 * ("#3FA9F5"), short hex ("#3af"), or sometimes a name. We accept hex only.
 */
function normalizeColour(value) {
  if (!value || typeof value !== 'string') return null;
  let v = value.trim();
  if (!v) return null;
  if (v.startsWith('#')) v = v.slice(1);
  if (/^[0-9a-f]{3}$/i.test(v)) {
    v = v.split('').map(c => c + c).join('');
  }
  if (!/^[0-9a-f]{6}$/i.test(v)) return null;
  return '#' + v.toLowerCase();
}

module.exports = { HaloClient };
