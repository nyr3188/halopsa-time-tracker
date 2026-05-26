'use strict';

/**
 * MockHaloClient — drop-in replacement for HaloClient used in Demo Mode.
 * Returns a fixed set of plausible tickets so the app can be demoed end-to-end
 * without real HaloPSA API credentials. Push operations intentionally fail
 * with a friendly "demo mode" error so demo data never leaks into a real
 * Halo tenant.
 */

const MOCK_TICKETS = [
  // Regular tickets
  { id: 4321, summary: 'Email not syncing on iPhone',         client_name: 'Acme Corp',        site_name: 'HQ',   status_id: 2, status_name: 'In Progress', type_name: 'Incident',     is_project: false, parent_project_id: null, parent_project_summary: '' },
  { id: 4325, summary: 'New laptop setup for marketing hire', client_name: 'Acme Corp',        site_name: 'HQ',   status_id: 1, status_name: 'New',         type_name: 'Request',      is_project: false, parent_project_id: null, parent_project_summary: '' },
  { id: 4338, summary: 'Printer offline in conference room',  client_name: 'Beta Industries',  site_name: 'Main', status_id: 2, status_name: 'In Progress', type_name: 'Incident',     is_project: false, parent_project_id: null, parent_project_summary: '' },
  { id: 4351, summary: 'VPN disconnects intermittently',      client_name: 'Delta Partners',   site_name: 'Main', status_id: 4, status_name: 'On Hold',     type_name: 'Incident',     is_project: false, parent_project_id: null, parent_project_summary: '' },
  { id: 4360, summary: 'Outlook calendar invites not appearing', client_name: 'Epsilon Co',    site_name: 'Main', status_id: 1, status_name: 'New',         type_name: 'Incident',     is_project: false, parent_project_id: null, parent_project_summary: '' },
  { id: 4364, summary: 'Set up MFA for new finance team',     client_name: 'Beta Industries',  site_name: 'Main', status_id: 2, status_name: 'In Progress', type_name: 'Request',      is_project: false, parent_project_id: null, parent_project_summary: '' },

  // Project tasks — grouped under two parent projects across two clients
  { id: 4342, summary: 'Inventory existing file shares',      client_name: 'Gamma LLC',        site_name: 'Main', status_id: 2, status_name: 'In Progress', type_name: 'Project Task', is_project: true,  parent_project_id: 4300, parent_project_summary: 'SharePoint Migration' },
  { id: 4343, summary: 'Map permissions to M365 groups',      client_name: 'Gamma LLC',        site_name: 'Main', status_id: 1, status_name: 'New',         type_name: 'Project Task', is_project: true,  parent_project_id: 4300, parent_project_summary: 'SharePoint Migration' },
  { id: 4344, summary: 'Pilot migration with marketing',      client_name: 'Gamma LLC',        site_name: 'Main', status_id: 1, status_name: 'New',         type_name: 'Project Task', is_project: true,  parent_project_id: 4300, parent_project_summary: 'SharePoint Migration' },
  { id: 4357, summary: 'Review prior pen-test report',        client_name: 'Acme Corp',        site_name: 'HQ',   status_id: 2, status_name: 'In Progress', type_name: 'Project Task', is_project: true,  parent_project_id: 4355, parent_project_summary: 'Q2 Security Audit' },
  { id: 4358, summary: 'Patch identified vulnerabilities',    client_name: 'Acme Corp',        site_name: 'HQ',   status_id: 1, status_name: 'New',         type_name: 'Project Task', is_project: true,  parent_project_id: 4355, parent_project_summary: 'Q2 Security Audit' },
];

const MOCK_STATUSES = [
  { id: 1, name: 'New',               colour: '#4f8cff', isClosed: false },
  { id: 2, name: 'In Progress',       colour: '#f59e0b', isClosed: false },
  { id: 3, name: 'Awaiting Customer', colour: '#a855f7', isClosed: false },
  { id: 4, name: 'On Hold',           colour: '#94a3b8', isClosed: false },
  { id: 5, name: 'Resolved',          colour: '#4ade80', isClosed: false },
  { id: 6, name: 'Closed',            colour: '#6b7280', isClosed: true  },
];

const MOCK_AGENT_ID = 9999;

class MockHaloClient {
  constructor() {
    this.isDemo = true;
  }

  async testConnection() {
    return true;
  }

  async findAgentIdByEmail(_email) {
    return MOCK_AGENT_ID;
  }

  async listMyTickets({ includeProjects = true } = {}) {
    const tickets = includeProjects
      ? MOCK_TICKETS
      : MOCK_TICKETS.filter(t => !t.is_project);
    return tickets.map(t => ({ ...t }));
  }

  async getStatuses() {
    return MOCK_STATUSES.map(s => ({ ...s }));
  }

  async postTicketAction(_args) {
    const err = new Error('Demo Mode — connect to HaloPSA to push sessions.');
    err.code = 'DEMO_MODE';
    throw err;
  }
}

module.exports = { MockHaloClient, MOCK_AGENT_ID };
