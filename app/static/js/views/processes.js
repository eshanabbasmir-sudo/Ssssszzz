// Processes: real psutil data, real signals.
import { api, esc, fmtBytes, fmtDuration, fmtTime } from '../api.js';
import { icon, toast, openSheet, confirmDialog, emptyState } from '../ui.js';

export default {
  async render(root) {
    root.innerHTML = `
      <div class="view">
        <div class="toolbar" style="margin-bottom:12px">
          <div class="search">${icon('search')}
            <input class="input input-sm" id="proc-search" placeholder="Filter by name, command, user or PID" autocomplete="off" spellcheck="false">
          </div>
          <div class="btn-group" id="proc-sort">
            <button data-sort="cpu" class="active">CPU</button>
            <button data-sort="memory">Memory</button>
            <button data-sort="pid">PID</button>
            <button data-sort="name">Name</button>
          </div>
          <button class="btn btn-icon btn-soft" id="proc-refresh" title="Refresh">${icon('refresh')}</button>
          <button class="btn btn-soft btn-sm" id="proc-autorefresh">${icon('clock', 'icon-sm')} Live</button>
        </div>
        <div class="card card-pad-0">
          <div class="table-wrap">
            <table class="data">
              <thead><tr>
                <th>PID</th><th>Name</th><th>User</th><th class="num">CPU %</th><th class="num">MEM %</th>
                <th>Status</th><th>Command</th><th></th>
              </tr></thead>
              <tbody id="proc-body"><tr><td colspan="8"><div class="loader"><div class="spinner"></div></div></td></tr></tbody>
            </table>
          </div>
          <div class="row small muted" style="padding:10px 14px;border-top:1px solid var(--border)">
            <span id="proc-total">—</span><div class="spacer"></div><span id="proc-stamp"></span>
          </div>
        </div>
      </div>`;

    const tbody = root.querySelector('#proc-body');
    const search = root.querySelector('#proc-search');
    let sort = 'cpu';
    let live = false;
    let timer = null;
    let current = [];
    let controller = null;

    async function load({ silent = false } = {}) {
      if (controller) controller.abort();
      controller = new AbortController();
      if (!silent) tbody.innerHTML = `<tr><td colspan="8"><div class="loader"><div class="spinner"></div></div></td></tr>`;
      try {
        const data = await api(`/api/system/processes?q=${encodeURIComponent(search.value.trim())}&sort=${sort}&limit=200`, { signal: controller.signal });
        current = data.processes;
        tbody.innerHTML = data.processes.length ? data.processes.map((p) => `
          <tr data-pid="${p.pid}">
            <td class="mono">${p.pid}</td>
            <td><span style="font-weight:550">${esc(p.name)}</span></td>
            <td class="mono">${esc(p.user)}</td>
            <td class="num">${p.cpu.toFixed(1)}</td>
            <td class="num">${p.memory.toFixed(1)}</td>
            <td><span class="badge ${p.status === 'running' ? 'badge-success' : p.status === 'sleeping' ? '' : 'badge-warning'}">${esc(p.status)}</span></td>
            <td class="mono truncate" style="max-width:340px" title="${esc(p.cmd)}">${esc(p.cmd)}</td>
            <td style="text-align:right;white-space:nowrap">
              <button class="btn btn-ghost btn-icon btn-sm" data-info="${p.pid}" title="Details">${icon('info', 'icon-sm')}</button>
              <button class="btn btn-ghost btn-icon btn-sm" data-kill="${p.pid}" title="Send signal">${icon('stop', 'icon-sm')}</button>
            </td>
          </tr>`).join('') : `<tr><td colspan="8">${emptyState({ icon: 'search', title: 'No matching processes' })}</td></tr>`;
        root.querySelector('#proc-total').textContent = `${data.total} process${data.total === 1 ? '' : 'es'} matched · showing ${data.processes.length}`;
        root.querySelector('#proc-stamp').textContent = `updated ${new Date().toLocaleTimeString()}`;
        bindRows();
      } catch (err) {
        if (err.name === 'AbortError' || err.status === 401) return;
        tbody.innerHTML = `<tr><td colspan="8"><div class="empty">${icon('alert')}<strong>${esc(err.message)}</strong></div></td></tr>`;
      }
    }

    function bindRows() {
      tbody.querySelectorAll('[data-info]').forEach((btn) => btn.addEventListener('click', () => showDetails(Number(btn.dataset.info))));
      tbody.querySelectorAll('[data-kill]').forEach((btn) => btn.addEventListener('click', () => showKill(btn, Number(btn.dataset.kill))));
      tbody.querySelectorAll('tr[data-pid]').forEach((row) => row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        showDetails(Number(row.dataset.pid));
      }));
    }

    async function showDetails(pid) {
      const body = document.createElement('div');
      body.innerHTML = '<div class="loader"><div class="spinner"></div></div>';
      const footer = document.createElement('div');
      footer.className = 'row';
      footer.style.width = '100%';
      footer.innerHTML = `<button class="btn btn-soft" data-refresh>${icon('refresh', 'icon-sm')} Refresh</button>
        <div class="spacer"></div><button class="btn btn-danger-soft" data-kill>${icon('stop', 'icon-sm')} Signal</button>`;
      const sheet = openSheet({ title: `Process ${pid}`, subtitle: 'Live process details', body, footer });
      const render = async () => {
        try {
          const p = await api(`/api/system/processes/${pid}`);
          body.innerHTML = `
            <dl class="kv">
              <dt>Name</dt><dd>${esc(p.name)}</dd>
              <dt>PID / PPID</dt><dd class="mono">${p.pid} / ${p.ppid}</dd>
              <dt>User</dt><dd>${esc(p.user || '—')}</dd>
              <dt>Status</dt><dd>${esc(p.status)}</dd>
              <dt>Executable</dt><dd class="mono">${esc(p.exe || '—')}</dd>
              <dt>Working dir</dt><dd class="mono">${esc(p.cwd || '—')}</dd>
              <dt>Started</dt><dd>${esc(fmtTime(p.created))} <span class="muted">(${fmtDuration(Date.now() / 1000 - p.created)} ago)</span></dd>
              <dt>CPU</dt><dd>${p.cpu_percent.toFixed(1)} %</dd>
              <dt>Memory</dt><dd>${fmtBytes(p.memory_rss)} RSS · ${fmtBytes(p.memory_vms)} virtual</dd>
              <dt>Threads</dt><dd>${p.threads}</dd>
              <dt>Connections</dt><dd>${p.connections}</dd>
              <dt>Open files</dt><dd>${p.open_files}</dd>
            </dl>
            <div class="label mt-3">Command line</div>
            <div class="code-box wrap mt-1">${esc((p.cmdline || []).join(' ') || '—')}</div>`;
        } catch (err) {
          body.innerHTML = `<div class="alert danger">${icon('alert')}<div>${esc(err.message)}</div></div>`;
        }
      };
      footer.querySelector('[data-refresh]').addEventListener('click', render);
      footer.querySelector('[data-kill]').addEventListener('click', () => { sheet.close(); showKill(footer, pid); });
      await render();
    }

    function showKill(anchor, pid) {
      const proc = current.find((p) => p.pid === pid);
      const body = document.createElement('div');
      body.innerHTML = `
        <p class="small" style="color:var(--text-secondary)">Send a signal to <strong>${esc(proc?.name || pid)}</strong>
        (PID ${pid}${proc ? `, user ${esc(proc.user)}` : ''}). SIGTERM allows a clean shutdown; SIGKILL cannot be caught.</p>
        <div class="chips mt-2">
          <button class="chip active" data-sig="TERM">SIGTERM</button>
          <button class="chip" data-sig="INT">SIGINT</button>
          <button class="chip" data-sig="HUP">SIGHUP</button>
          <button class="chip" data-sig="KILL">SIGKILL</button>
        </div>
        <div class="alert warn mt-2">${icon('alert')}<div>Signals are delivered by the kernel with the panel's privileges. Some processes will reject them.</div></div>`;
      const footer = document.createElement('div');
      footer.className = 'row';
      footer.style.width = '100%';
      footer.innerHTML = `<div class="spacer"></div><button class="btn btn-soft" data-cancel>Cancel</button>
        <button class="btn btn-danger" data-send>Send signal</button>`;
      const sheet = openSheet({ title: 'Send signal', subtitle: `PID ${pid}`, body, footer });
      let sig = 'TERM';
      body.querySelectorAll('[data-sig]').forEach((btn) => btn.addEventListener('click', () => {
        body.querySelectorAll('[data-sig]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        sig = btn.dataset.sig;
      }));
      footer.querySelector('[data-cancel]').addEventListener('click', () => sheet.close());
      footer.querySelector('[data-send]').addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: 'Confirm signal',
          message: `Send SIG${sig} to PID ${pid}${proc ? ` (${proc.name})` : ''}?`,
          confirmLabel: 'Send SIG' + sig,
          danger: sig === 'KILL',
        });
        if (!ok) return;
        try {
          await api(`/api/system/processes/${pid}/kill`, { method: 'POST', body: { signal: sig } });
          toast(`SIG${sig} sent to PID ${pid}`, { type: 'success' });
          sheet.close();
          load({ silent: true });
        } catch (err) {
          toast(err.message, { type: 'error' });
        }
      });
    }

    let searchTimer = null;
    search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => load({ silent: true }), 260);
    });
    root.querySelectorAll('[data-sort]').forEach((btn) => btn.addEventListener('click', () => {
      root.querySelectorAll('[data-sort]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      sort = btn.dataset.sort;
      load({ silent: true });
    }));
    root.querySelector('#proc-refresh').addEventListener('click', () => load());
    const liveBtn = root.querySelector('#proc-autorefresh');
    liveBtn.addEventListener('click', () => {
      live = !live;
      liveBtn.classList.toggle('btn-primary', live);
      liveBtn.classList.toggle('btn-soft', !live);
      if (live) {
        timer = setInterval(() => { if (document.visibilityState === 'visible') load({ silent: true }); }, 3000);
        load({ silent: true });
      } else if (timer) {
        clearInterval(timer);
        timer = null;
      }
    });

    await load();
    return () => {
      if (timer) clearInterval(timer);
      if (controller) controller.abort();
      clearTimeout(searchTimer);
    };
  },
};
