// systemd services: real status and control.
import { api, esc } from '../api.js';
import { icon, toast, openSheet, emptyState, badgeForStatus, confirmDialog } from '../ui.js';

export default {
  async render(root) {
    root.innerHTML = `
      <div class="view">
        <div class="toolbar" style="margin-bottom:12px">
          <div class="search">${icon('search')}
            <input class="input input-sm" id="svc-search" placeholder="Filter services" autocomplete="off" spellcheck="false">
          </div>
          <div class="seg-ctl" id="svc-filter">
            <button class="active" data-filter="active">Running</button>
            <button data-filter="all">All</button>
            <button data-filter="failed">Failed</button>
          </div>
          <button class="btn btn-icon btn-soft" id="svc-refresh" title="Refresh">${icon('refresh')}</button>
        </div>
        <div id="svc-note"></div>
        <div class="card card-pad-0 mt-2">
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>Unit</th><th>State</th><th>Description</th><th style="text-align:right">Actions</th></tr></thead>
              <tbody id="svc-body"><tr><td colspan="4"><div class="loader"><div class="spinner"></div></div></td></tr></tbody>
            </table>
          </div>
        </div>
      </div>`;

    const tbody = root.querySelector('#svc-body');
    const note = root.querySelector('#svc-note');
    let services = [];
    let filter = 'active';
    let query = '';
    let unavailable = false;

    function render() {
      let list = services;
      if (filter === 'active') list = list.filter((s) => s.active === 'active');
      if (filter === 'failed') list = list.filter((s) => s.active === 'failed' || s.sub === 'failed');
      if (query) {
        const needle = query.toLowerCase();
        list = list.filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(needle));
      }
      if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="4">${emptyState({ icon: 'server', title: unavailable ? 'systemd unavailable' : 'No services match', text: unavailable ? 'Service management requires systemd on this host.' : '' })}</td></tr>`;
        return;
      }
      tbody.innerHTML = list.map((s) => `
        <tr data-name="${esc(s.name)}">
          <td><span style="font-weight:550">${esc(s.name.replace(/\.service$/, ''))}</span>
            <div class="small muted">${esc(s.load)}</div></td>
          <td>${badgeForStatus(s.active, s.sub)}</td>
          <td class="truncate" style="max-width:360px">${esc(s.description)}</td>
          <td style="text-align:right;white-space:nowrap">
            ${s.active === 'active'
              ? `<button class="btn btn-ghost btn-icon btn-sm" data-act="restart" data-unit="${esc(s.name)}" title="Restart">${icon('refresh', 'icon-sm')}</button>
                 <button class="btn btn-ghost btn-icon btn-sm" data-act="stop" data-unit="${esc(s.name)}" title="Stop">${icon('stop', 'icon-sm')}</button>`
              : `<button class="btn btn-ghost btn-icon btn-sm" data-act="start" data-unit="${esc(s.name)}" title="Start">${icon('play', 'icon-sm')}</button>`}
            <button class="btn btn-ghost btn-icon btn-sm" data-log="${esc(s.name)}" title="View log">${icon('file-text', 'icon-sm')}</button>
          </td>
        </tr>`).join('');
      tbody.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', () => act(btn.dataset.unit, btn.dataset.act)));
      tbody.querySelectorAll('[data-log]').forEach((btn) => btn.addEventListener('click', () => showLog(btn.dataset.log)));
    }

    async function act(unit, action) {
      if (action === 'stop' || action === 'restart') {
        const ok = await confirmDialog({
          title: `${action === 'stop' ? 'Stop' : 'Restart'} ${unit}?`,
          message: `${unit} will be ${action === 'stop' ? 'stopped' : 'restarted'} immediately through systemctl. This affects the running system.`,
          confirmLabel: action === 'stop' ? 'Stop unit' : 'Restart unit',
          danger: true,
        });
        if (!ok) return;
      }
      try {
        const res = await api(`/api/system/services/${encodeURIComponent(unit)}/action`, { method: 'POST', body: { action } });
        if (res.ok) toast(`${unit}: ${action} succeeded`, { type: 'success' });
        else toast(`${unit}: ${action} exited with code ${res.exit_code}`, { type: 'error' });
        await load();
      } catch (err) {
        toast(err.message, { type: 'error' });
      }
    }

    async function showLog(unit) {
      const body = document.createElement('div');
      body.innerHTML = '<div class="loader"><div class="spinner"></div></div>';
      const sheet = openSheet({ title: 'Service log', subtitle: unit, body, size: 'wide' });
      try {
        const res = await api(`/api/system/logs/read?source=${encodeURIComponent(`journal:${unit}`)}&lines=300`);
        body.innerHTML = `<div class="code-box wrap">${esc(res.content || '(no entries)')}</div>`;
      } catch (err) {
        body.innerHTML = `<div class="alert warn">${icon('alert')}<div>${esc(err.message)}</div></div>`;
      }
    }

    async function load() {
      tbody.innerHTML = `<tr><td colspan="4"><div class="loader"><div class="spinner"></div></div></td></tr>`;
      try {
        const data = await api('/api/system/services');
        unavailable = !data.available;
        services = data.services || [];
        note.innerHTML = data.available
          ? `<div class="alert">${icon('info')}<div>${services.length} units reported by systemd. Actions run through <span class="mono">systemctl</span>.</div></div>`
          : `<div class="alert warn">${icon('alert')}<div><strong>systemd is not available in this environment.</strong> ${esc(data.reason || '')}
             Services cannot be managed here.</div></div>`;
        render();
      } catch (err) {
        tbody.innerHTML = `<tr><td colspan="4"><div class="empty">${icon('alert')}<strong>${esc(err.message)}</strong></div></td></tr>`;
      }
    }

    root.querySelector('#svc-search').addEventListener('input', (e) => { query = e.target.value.trim(); render(); });
    root.querySelectorAll('[data-filter]').forEach((btn) => btn.addEventListener('click', () => {
      root.querySelectorAll('[data-filter]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      filter = btn.dataset.filter;
      render();
    }));
    root.querySelector('#svc-refresh').addEventListener('click', load);

    await load();
    return () => {};
  },
};
