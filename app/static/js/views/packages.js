// Package management using the host's real package manager.
import { api, esc } from '../api.js';
import { icon, toast, openSheet, emptyState, confirmDialog, promptDialog } from '../ui.js';

export default {
  async render(root) {
    root.innerHTML = `
      <div class="view">
        <div id="pkg-note"></div>
        <div class="toolbar mt-2" style="margin-bottom:12px">
          <div class="search">${icon('search')}
            <input class="input input-sm" id="pkg-search" placeholder="Filter installed packages" autocomplete="off" spellcheck="false">
          </div>
          <button class="btn btn-soft btn-sm" id="pkg-install">${icon('download', 'icon-sm')} Install package</button>
          <button class="btn btn-icon btn-soft" id="pkg-refresh" title="Refresh index">${icon('refresh')}</button>
        </div>
        <div class="card card-pad-0">
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>Package</th><th>Version</th><th>Status</th><th style="text-align:right">Action</th></tr></thead>
              <tbody id="pkg-body"><tr><td colspan="4"><div class="loader"><div class="spinner"></div></div></td></tr></tbody>
            </table>
          </div>
          <div class="row small muted" style="padding:10px 14px;border-top:1px solid var(--border)">
            <span id="pkg-total">—</span><div class="spacer"></div><span id="pkg-cap"></span>
          </div>
        </div>
      </div>`;

    const tbody = root.querySelector('#pkg-body');
    const note = root.querySelector('#pkg-note');
    const totalBox = root.querySelector('#pkg-total');
    const capBox = root.querySelector('#pkg-cap');
    let packages = [];
    let manager = null;
    let canModify = false;

    function render(filter = '') {
      const needle = filter.toLowerCase();
      const list = needle ? packages.filter((p) => p.name.toLowerCase().includes(needle)) : packages;
      if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="4">${emptyState({ icon: 'box', title: packages.length ? 'No matching packages' : 'No packages reported' })}</td></tr>`;
        return;
      }
      const slice = list.slice(0, 400);
      tbody.innerHTML = slice.map((p) => `
        <tr>
          <td class="mono">${esc(p.name)}</td>
          <td class="mono">${esc(p.version)}</td>
          <td><span class="badge ${p.status === 'upgradable' ? 'badge-warning' : 'badge-success'}">${esc(p.status)}</span></td>
          <td style="text-align:right">
            <button class="btn btn-ghost btn-icon btn-sm" data-remove="${esc(p.name)}" title="Remove package" ${canModify ? '' : 'disabled'}>${icon('trash', 'icon-sm')}</button>
          </td>
        </tr>`).join('');
      totalBox.textContent = `${list.length} package(s)${list.length > 400 ? ' · showing first 400' : ''}`;
      tbody.querySelectorAll('[data-remove]').forEach((btn) => btn.addEventListener('click', () => removePackage(btn.dataset.remove)));
    }

    async function load(force = false) {
      tbody.innerHTML = `<tr><td colspan="4"><div class="loader"><div class="spinner"></div></div></td></tr>`;
      try {
        const data = await api(`/api/system/packages?refresh=${force ? 'true' : 'false'}`);
        if (!data.available) {
          note.innerHTML = `<div class="alert warn">${icon('alert')}<div><strong>No supported package manager.</strong> ${esc(data.reason || '')}</div></div>`;
          tbody.innerHTML = `<tr><td colspan="4">${emptyState({ icon: 'box', title: 'Package management unavailable' })}</td></tr>`;
          return;
        }
        manager = data.manager;
        canModify = data.is_root;
        packages = data.packages || [];
        note.innerHTML = `<div class="alert ${data.is_root ? '' : 'warn'}">${icon('info')}<div>
          Package manager: <strong>${esc(data.manager)}</strong>. ${data.is_root
            ? 'The panel runs as root, so install/remove actions are available.'
            : 'The panel runs without root privileges — install/remove is disabled; listing still works.'}
          ${data.truncated ? '<div class="small mt-1">Large package set: only the first 2000 entries are returned.</div>' : ''}
        </div></div>`;
        capBox.textContent = `${data.total} installed`;
        render(root.querySelector('#pkg-search').value.trim());
      } catch (err) {
        tbody.innerHTML = `<tr><td colspan="4"><div class="empty">${icon('alert')}<strong>${esc(err.message)}</strong></div></td></tr>`;
      }
    }

    async function runAction(name, action) {
      const body = document.createElement('div');
      body.innerHTML = `<div class="row"><div class="spinner"></div><span class="small">Running ${esc(action)} for <strong>${esc(name)}</strong>… this can take a while.</span></div>
        <div class="code-box wrap mt-2" id="pkg-out" style="max-height:320px">starting…</div>`;
      const footer = document.createElement('div');
      footer.className = 'row';
      footer.style.width = '100%';
      footer.innerHTML = `<div class="spacer"></div><button class="btn btn-soft" data-close disabled>Close</button>`;
      const sheet = openSheet({ title: `${action === 'install' ? 'Install' : 'Remove'} ${name}`, subtitle: 'Live command output', body, footer, dismissible: false });
      try {
        const res = await api(`/api/system/packages/${encodeURIComponent(name)}/action`, { method: 'POST', body: { action } });
        const out = body.querySelector('#pkg-out');
        out.textContent = `$ ${res.command || ''}\nexit code: ${res.exit_code}\n\n${res.output || '(no output)'}`;
        out.style.borderLeft = `3px solid ${res.ok ? 'var(--success)' : 'var(--danger)'}`;
        toast(res.ok ? `${name} ${action === 'install' ? 'installed' : 'removed'}` : `${action} failed (exit ${res.exit_code})`, { type: res.ok ? 'success' : 'error' });
        body.querySelector('.spinner').parentElement.innerHTML = res.ok
          ? `<span class="badge badge-success">${icon('check', 'icon-sm')} completed</span>`
          : `<span class="badge badge-danger">failed</span>`;
        await load(true);
      } catch (err) {
        body.querySelector('#pkg-out').textContent = err.message;
        body.querySelector('#pkg-out').style.borderLeft = '3px solid var(--danger)';
        toast(err.message, { type: 'error' });
      } finally {
        footer.querySelector('[data-close]').disabled = false;
        footer.querySelector('[data-close]').addEventListener('click', () => sheet.close());
      }
    }

    async function installPackage() {
      if (!canModify) { toast('Install requires the panel to run as root.', { type: 'warn' }); return; }
      const name = await promptDialog({
        title: 'Install package',
        label: 'Package name',
        placeholder: 'e.g. htop',
        hint: `Uses ${manager || 'the system package manager'} to install from configured repositories.`,
        confirmLabel: 'Continue',
      });
      if (!name) return;
      const ok = await confirmDialog({
        title: 'Confirm installation',
        message: `Install "${name}" using ${manager}? This modifies the system and may download packages from the network.`,
        confirmLabel: 'Install',
      });
      if (ok) runAction(name.trim(), 'install');
    }

    async function removePackage(name) {
      const ok = await confirmDialog({
        title: `Remove ${name}?`,
        message: `This runs ${manager} to remove "${name}" from the system. Dependent packages may also be affected.`,
        confirmLabel: 'Remove',
        danger: true,
        requireText: name,
      });
      if (ok) runAction(name, 'remove');
    }

    root.querySelector('#pkg-search').addEventListener('input', (e) => render(e.target.value.trim()));
    root.querySelector('#pkg-refresh').addEventListener('click', () => load(true));
    root.querySelector('#pkg-install').addEventListener('click', installPackage);

    await load();
    return () => {};
  },
};
