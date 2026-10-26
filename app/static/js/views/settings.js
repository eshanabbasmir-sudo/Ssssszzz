// Settings: account, security, appearance, panel info and audit log.
import { api, esc, fmtBytes, fmtDuration, fmtRelative, fmtTime } from '../api.js';
import { icon, toast, confirmDialog, emptyState, openSheet } from '../ui.js';

export default {
  async render(root, ctx) {
    let tab = ctx.params.get('tab') || 'account';
    let me = ctx.user;

    root.innerHTML = `
      <div class="view">
        <div class="chips" id="set-tabs" style="margin-bottom:14px">
          ${[['account', 'Account'], ['security', 'Security'], ['appearance', 'Appearance'], ['panel', 'Panel'], ['audit', 'Audit log'], ['about', 'About']]
            .map(([id, label]) => `<button class="chip ${id === tab ? 'active' : ''}" data-tab="${id}">${label}</button>`).join('')}
        </div>
        <div id="set-body"></div>
      </div>`;

    const body = root.querySelector('#set-body');

    function setTab(next) {
      tab = next;
      root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === next));
      history.replaceState(null, '', `#/settings${next === 'account' ? '' : `?tab=${next}`}`);
      renderTab();
    }

    root.querySelectorAll('[data-tab]').forEach((btn) => btn.addEventListener('click', () => setTab(btn.dataset.tab)));

    async function renderTab() {
      body.innerHTML = '<div class="loader"><div class="spinner"></div></div>';
      try {
        if (tab === 'account') await renderAccount();
        else if (tab === 'security') await renderSecurity();
        else if (tab === 'appearance') renderAppearance();
        else if (tab === 'panel') await renderPanel();
        else if (tab === 'audit') await renderAudit();
        else renderAbout();
      } catch (err) {
        body.innerHTML = `<div class="alert danger">${icon('alert')}<div>${esc(err.message)}</div></div>`;
      }
    }

    async function renderAccount() {
      const info = await api('/api/system/overview');
      const sessionList = await api('/api/auth/sessions');
      const sessionIp = sessionList.sessions.find((s) => s.current)?.ip || '';
      me = { ...me, ...(info.panel || {}) };
      body.innerHTML = `
        <div class="grid grid-2" style="align-items:start">
          <div class="card">
            <div class="card-head">${icon('user')}<h3>Profile</h3></div>
            <div class="row" style="gap:14px;margin-bottom:14px">
              <div class="avatar" style="width:52px;height:52px;font-size:19px">${esc((ctx.user.username || 'U')[0].toUpperCase())}</div>
              <div>
                <div style="font-weight:650;font-size:16px">${esc(ctx.user.username)}</div>
                <div class="small muted">${ctx.user.is_admin ? 'Administrator' : 'User'} · ${esc(info.host.hostname)}</div>
              </div>
            </div>
            <dl class="kv">
              <dt>Session IP</dt><dd class="mono">${esc(sessionIp || '—')}</dd>
              <dt>Panel version</dt><dd>${esc(info.panel?.version || '')}</dd>
              <dt>Panel uptime</dt><dd>${fmtDuration(info.panel?.uptime)}</dd>
              <dt>Terminal sessions</dt><dd>${info.panel?.sessions_total ?? 0}</dd>
            </dl>
          </div>
          <div class="card">
            <div class="card-head">${icon('lock')}<h3>Change password</h3></div>
            <form id="pw-form" class="stack" style="gap:12px">
              <div class="field"><label>Current password</label><input class="input" type="password" id="pw-current" autocomplete="current-password" required></div>
              <div class="field"><label>New password</label><input class="input" type="password" id="pw-new" autocomplete="new-password" minlength="10" required>
                <span class="small muted">At least 10 characters.</span></div>
              <div class="field"><label>Repeat new password</label><input class="input" type="password" id="pw-repeat" autocomplete="new-password" required></div>
              <button class="btn btn-primary" type="submit">${icon('save', 'icon-sm')} Update password</button>
            </form>
          </div>
        </div>`;
      body.querySelector('#pw-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const current = body.querySelector('#pw-current').value;
        const next = body.querySelector('#pw-new').value;
        const repeat = body.querySelector('#pw-repeat').value;
        if (next !== repeat) { toast('New passwords do not match.', { type: 'warn' }); return; }
        try {
          await api('/api/auth/password', { method: 'POST', body: { current_password: current, new_password: next } });
          toast('Password updated. Other sessions were signed out.', { type: 'success' });
          e.target.reset();
        } catch (err) {
          toast(err.message, { type: 'error' });
        }
      });
    }

    async function renderSecurity() {
      const data = await api('/api/auth/sessions');
      body.innerHTML = `
        <div class="card">
          <div class="card-head">${icon('shield')}<h3>Signed-in sessions</h3><div class="spacer"></div>
            <button class="btn btn-ghost btn-sm" id="sess-refresh">${icon('refresh', 'icon-sm')} Refresh</button></div>
          <div class="list">
            ${data.sessions.map((s) => `
              <div class="list-item" style="cursor:default;align-items:flex-start">
                ${icon(s.current ? 'check' : 'lock')}
                <div class="list-main">
                  <div class="list-title">${s.current ? 'This device' : 'Signed-in device'}
                    <span class="badge ${s.current ? 'badge-success' : ''}">${esc(s.ip || 'unknown ip')}</span></div>
                  <div class="list-sub">${esc(s.user_agent || 'unknown browser')}</div>
                  <div class="list-sub">created ${fmtRelative(s.created_at)} · last seen ${fmtRelative(s.last_seen)} · expires ${fmtTime(s.expires_at)}</div>
                </div>
                <button class="btn btn-sm btn-danger-soft" data-revoke="${esc(s.id)}">${s.current ? 'Sign out' : 'Revoke'}</button>
              </div>`).join('')}
          </div>
        </div>
        <div class="card mt-2">
          <div class="card-head">${icon('info')}<h3>Security model</h3></div>
          <dl class="kv">
            <dt>Passwords</dt><dd>scrypt (N=16384, r=8, p=1) with per-user salt</dd>
            <dt>Session cookies</dt><dd>HttpOnly, SameSite=Lax, signed random 256-bit token stored hashed</dd>
            <dt>CSRF</dt><dd>Double-submit token required on every state-changing request</dd>
            <dt>Login throttling</dt><dd>Failed attempts limited per IP and username</dd>
            <dt>WebSockets</dt><dd>Session cookie + origin validation on every terminal socket</dd>
            <dt>Filesystem</dt><dd>Path resolution through <span class="mono">realpath</span>, root confinement, protected system paths</dd>
          </dl>
          <div class="alert warn mt-2">${icon('alert')}<div>
            This panel can execute commands and modify files with the privileges of its service account.
            Serve it over HTTPS (reverse proxy) and restrict access to trusted networks.
          </div></div>
        </div>`;
      const refresh = body.querySelector('#sess-refresh');
      if (refresh) refresh.addEventListener('click', renderSecurity);
      body.querySelectorAll('[data-revoke]').forEach((btn) => btn.addEventListener('click', async () => {
        const ok = await confirmDialog({ title: 'Revoke session?', message: 'That device will be signed out immediately.', confirmLabel: 'Revoke', danger: true });
        if (!ok) return;
        try {
          await api(`/api/auth/sessions/${btn.dataset.revoke}`, { method: 'DELETE' });
          toast('Session revoked', { type: 'success' });
          if (btn.textContent.includes('Sign out')) location.reload();
          else renderSecurity();
        } catch (err) { toast(err.message, { type: 'error' }); }
      }));
    }

    function renderAppearance() {
      const stored = localStorage.getItem('pt-theme') || 'system';
      body.innerHTML = `
        <div class="card">
          <div class="card-head">${icon('sun')}<h3>Theme</h3></div>
          <div class="seg-ctl" id="theme-choice">
            <button data-theme="system" class="${stored === 'system' ? 'active' : ''}">System</button>
            <button data-theme="light" class="${stored === 'light' ? 'active' : ''}">Light</button>
            <button data-theme="dark" class="${stored === 'dark' ? 'active' : ''}">Dark</button>
          </div>
          <p class="small muted mt-2">Motion follows the operating system's reduced-motion preference automatically.</p>
        </div>
        <div class="card mt-2">
          <div class="card-head">${icon('terminal')}<h3>Terminal</h3></div>
          <div class="row">
            <div class="field" style="max-width:220px">
              <label>Font size</label>
              <select class="select" id="set-font">
                ${[11, 12, 12.5, 13.5, 15, 16, 18, 20].map((n) => `<option value="${n}" ${Number(localStorage.getItem('pt-term-font') || 13.5) === n ? 'selected' : ''}>${n}px</option>`).join('')}
              </select>
            </div>
          </div>
          <p class="small muted mt-2">Use the terminal toolbar for an on-screen key bar on mobile.</p>
        </div>`;
      body.querySelectorAll('[data-theme]').forEach((btn) => btn.addEventListener('click', () => {
        body.querySelectorAll('[data-theme]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        if (window.__ptApplyTheme) window.__ptApplyTheme(btn.dataset.theme);
        else localStorage.setItem('pt-theme', btn.dataset.theme);
      }));
      body.querySelector('#set-font').addEventListener('change', (e) => {
        localStorage.setItem('pt-term-font', e.target.value);
        toast('Terminal font size saved. Reopen the terminal to apply.', { type: 'info' });
      });
    }

    async function renderPanel() {
      const data = await api('/api/system/panel');
      const cfg = data.config;
      const caps = data.capabilities;
      const capRow = (label, ok, detail) => `
        <div class="list-item" style="cursor:default">
          <span class="dot ${ok ? '' : 'warn'}"></span>
          <div class="list-main"><div class="list-title">${esc(label)}</div>
            <div class="list-sub">${esc(detail || (ok ? 'available' : 'unavailable'))}</div></div>
          <span class="badge ${ok ? 'badge-success' : 'badge-warning'}">${ok ? 'ready' : 'limited'}</span>
        </div>`;
      body.innerHTML = `
        <div class="grid grid-2" style="align-items:start">
          <div class="card">
            <div class="card-head">${icon('settings')}<h3>Configuration</h3></div>
            <dl class="kv">
              <dt>Bind address</dt><dd class="mono">${esc(cfg.host)}:${cfg.port}</dd>
              <dt>Filesystem root</dt><dd class="mono">${esc(cfg.fs_root)}</dd>
              <dt>Max upload</dt><dd>${cfg.max_upload_mb} MB</dd>
              <dt>Max editable file</dt><dd>${fmtBytes(cfg.max_edit_bytes)}</dd>
              <dt>Session lifetime</dt><dd>${cfg.session_hours} h</dd>
              <dt>Terminal idle timeout</dt><dd>${cfg.terminal_idle_minutes} min</dd>
              <dt>Terminal session limit</dt><dd>${cfg.max_terminal_sessions}</dd>
              <dt>TLS</dt><dd>${cfg.tls ? 'enabled' : 'not configured (use a reverse proxy)'}</dd>
              <dt>Protected paths</dt><dd class="mono small">${cfg.protected_paths.map(esc).join(', ')}</dd>
            </dl>
            <p class="small muted mt-2">Edit <span class="mono">config.json</span> in the panel data directory and run
              <span class="mono">bash panel.sh restart</span> to change these values.</p>
          </div>
          <div class="card">
            <div class="card-head">${icon('check')}<h3>Capabilities</h3></div>
            <div class="list">
              ${capRow('Terminal (PTY)', caps.terminal?.available, caps.terminal?.shell)}
              ${capRow('Filesystem', caps.filesystem?.available, `root ${caps.filesystem?.root}${caps.filesystem?.writable ? '' : ' (read-only for panel user)'}`)}
              ${capRow('Services (systemd)', caps.services?.available, caps.services?.reason)}
              ${capRow('Packages', caps.packages?.available, `${caps.packages?.manager || 'none'}${caps.packages?.can_modify ? ' · install/remove enabled' : ' · read-only (not root)'}`)}
              ${capRow('Root privileges', caps.root?.is_root, caps.root?.note)}
              ${capRow('systemd journal', caps.logs?.journal, caps.logs?.journal_reason)}
              ${capRow('ping', caps.diagnostics?.ping, 'network diagnostics')}
              ${capRow('traceroute', caps.diagnostics?.traceroute, 'network diagnostics')}
              ${capRow('SSH key management', caps.ssh_keys?.writable, caps.ssh_keys?.reason)}
              ${capRow('Python runner', caps.python_runner?.available, caps.python_runner?.executable)}
            </div>
          </div>
        </div>`;
    }

    async function renderAudit() {
      const data = await api('/api/system/audit?limit=200');
      body.innerHTML = `
        <div class="card card-pad-0">
          <div class="row" style="padding:14px 14px 10px">
            ${icon('shield')}<strong style="font-size:14.5px">Audit trail</strong>
            <div class="spacer"></div>
            <span class="small muted">${data.entries.length} recent entries</span>
            <button class="btn btn-ghost btn-sm" id="audit-refresh">${icon('refresh', 'icon-sm')}</button>
          </div>
          <div class="table-wrap" style="max-height:60dvh;overflow:auto">
            <table class="data">
              <thead><tr><th>When</th><th>User</th><th>Action</th><th>Detail</th><th>IP</th></tr></thead>
              <tbody>
                ${data.entries.length ? data.entries.map((e) => `<tr>
                  <td class="nowrap small">${fmtTime(e.ts)}</td>
                  <td class="mono">${esc(e.username)}</td>
                  <td><span class="badge">${esc(e.action)}</span></td>
                  <td class="small" style="max-width:340px;word-break:break-word">${esc(e.detail || '')}</td>
                  <td class="mono small">${esc(e.ip || '')}</td>
                </tr>`).join('') : `<tr><td colspan="5">${emptyState({ icon: 'list', title: 'No audit entries yet' })}</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>`;
      body.querySelector('#audit-refresh').addEventListener('click', renderAudit);
    }

    function renderAbout() {
      body.innerHTML = `
        <div class="card">
          <div class="row" style="gap:14px">
            <div class="brand-mark" style="width:52px;height:52px;border-radius:16px">${icon('terminal', 'icon-lg')}</div>
            <div>
              <h3 style="font-size:18px">PRIME TERMINAL</h3>
              <div class="small muted">Linux control panel · version ${esc(window.__PT_VERSION || '1.0.0')}</div>
            </div>
          </div>
          <p class="small mt-2" style="color:var(--text-secondary);line-height:1.7">
            A self-hosted control panel that talks directly to the Linux system it runs on: a real PTY terminal,
            a real filesystem manager, live psutil metrics and real systemd / package-manager control.
            Nothing on these screens is simulated — when the host cannot provide something, the panel says so.
          </p>
        </div>
        <div class="card mt-2">
          <div class="card-head">${icon('server')}<h3>Management commands</h3></div>
          <div class="code-box wrap">bash panel.sh start|stop|restart|status
bash panel.sh logs          # tail the service log
bash panel.sh update        # re-apply dependencies and restart
bash panel.sh reset-password
bash panel.sh set-port 8080
bash panel.sh uninstall</div>
          <p class="small muted mt-2">Run these on the server in the directory that contains <span class="mono">panel.sh</span>.</p>
        </div>
        <div class="card mt-2">
          <div class="card-head">${icon('shield')}<h3>Recommended hardening</h3></div>
          <ul class="small" style="color:var(--text-secondary);line-height:1.8;padding-left:18px;margin:0">
            <li>Put the panel behind an HTTPS reverse proxy (Caddy, nginx) and keep port ${esc(String(location.port))} closed to the internet.</li>
            <li>Run the panel unprivileged when you do not need package or service management.</li>
            <li>Use a long unique password and restrict access with a firewall or VPN.</li>
            <li>Review the audit log regularly.</li>
          </ul>
        </div>`;
    }

    await renderTab();
    return () => {};
  },
};
