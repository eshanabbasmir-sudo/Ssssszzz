// Network: interfaces, routes, listening ports, real diagnostics.
import { api, esc, fmtBytes, fmtDuration } from '../api.js';
import { icon, toast, emptyState, openSheet } from '../ui.js';

export default {
  async render(root) {
    root.innerHTML = `
      <div class="view">
        <div class="grid grid-2" style="align-items:start">
          <div class="card">
            <div class="card-head">${icon('wifi')}<h3>Interfaces</h3><div class="spacer"></div>
              <button class="btn btn-ghost btn-sm" id="net-refresh">${icon('refresh', 'icon-sm')}</button></div>
            <div id="net-ifaces"><div class="loader"><div class="spinner"></div></div></div>
          </div>
          <div class="card">
            <div class="card-head">${icon('list')}<h3>Listening ports</h3><div class="spacer"></div>
              <span class="small muted" id="net-ports-count"></span></div>
            <div id="net-ports" style="max-height:420px;overflow:auto"><div class="loader"><div class="spinner"></div></div></div>
          </div>
        </div>

        <div class="card mt-2">
          <div class="card-head">${icon('zap')}<h3>Diagnostics</h3><div class="spacer"></div>
            <div class="seg-ctl" id="diag-tabs">
              <button class="active" data-diag="ping">Ping</button>
              <button data-diag="traceroute">Traceroute</button>
              <button data-diag="dns">DNS</button>
            </div>
          </div>
          <div class="row nowrap">
            <input class="input mono" id="diag-host" placeholder="example.com or 1.1.1.1" value="1.1.1.1" style="flex:1">
            <button class="btn btn-primary" id="diag-run">${icon('play', 'icon-sm')} Run</button>
          </div>
          <div class="code-box wrap mt-2" id="diag-out" style="min-height:80px;color:var(--text-secondary)">Choose a target and run a diagnostic. Commands run on the server with its network stack.</div>
        </div>
      </div>`;

    const ifaceBox = root.querySelector('#net-ifaces');
    const portsBox = root.querySelector('#net-ports');
    const portsCount = root.querySelector('#net-ports-count');
    const diagOut = root.querySelector('#diag-out');
    const diagHost = root.querySelector('#diag-host');
    let mode = 'ping';
    let metricsTimer = null;

    function renderInterfaces(data) {
      const list = data.interfaces || [];
      if (!list.length) {
        ifaceBox.innerHTML = emptyState({ icon: 'wifi', title: 'No interfaces reported' });
      } else {
        ifaceBox.innerHTML = list.map((i) => {
          const v4 = (i.addresses || []).filter((a) => a.family === 'ipv4');
          const v6 = (i.addresses || []).filter((a) => a.family === 'ipv6');
          const mac = (i.addresses || []).find((a) => a.family === 'mac');
          return `<div style="padding:12px 0;border-bottom:1px solid var(--border)">
            <div class="row" style="gap:8px">
              <span class="dot ${i.is_up ? '' : 'bad'}"></span>
              <strong style="font-size:13.5px">${esc(i.name)}</strong>
              <span class="badge">${i.is_up ? 'up' : 'down'}</span>
              ${i.speed_mbps ? `<span class="badge">${i.speed_mbps} Mb/s</span>` : ''}
              <div class="spacer"></div>
              <span class="small muted">MTU ${i.mtu ?? '—'}</span>
            </div>
            <div class="small mono muted mt-1">
              ${v4.map((a) => `${esc(a.address)}${a.netmask ? `/${esc(a.netmask)}` : ''}`).join(' · ') || 'no IPv4'}
              ${v6.length ? `<br>${esc(v6[0].address)}` : ''}
              ${mac ? `<br>${esc(mac.address)}` : ''}
            </div>
            <div class="row small muted mt-1" style="gap:14px">
              <span>${icon('arrow-down', 'icon-sm')} ${fmtBytes(i.bytes_recv)}</span>
              <span>${icon('arrow-up', 'icon-sm')} ${fmtBytes(i.bytes_sent)}</span>
              ${i.errors_in || i.errors_out ? `<span style="color:var(--warning)">errors ${i.errors_in}/${i.errors_out}</span>` : ''}
            </div>
          </div>`;
        }).join('');
      }
      const routes = data.routes || [];
      if (routes.length) {
        ifaceBox.insertAdjacentHTML('beforeend', `<div class="small muted mt-2">Default route: ${routes.map((r) => `<span class="mono">${esc(r.gateway || '—')} via ${esc(r.interface)}</span>`).join(', ')}</div>`);
      }
    }

    function renderPorts(data) {
      if (!data.ports || !data.ports.length) {
        portsBox.innerHTML = emptyState({ icon: 'globe', title: 'No listening TCP/UDP ports found', text: data.note || '' });
        portsCount.textContent = '';
        return;
      }
      portsCount.textContent = `${data.ports.length} open${data.partial ? ' (partial)' : ''}`;
      portsBox.innerHTML = `<div class="table-wrap"><table class="data">
        <thead><tr><th>Port</th><th>Address</th><th>Process</th><th>PID</th></tr></thead>
        <tbody>${data.ports.map((p) => `<tr>
          <td class="mono"><strong>${p.port}</strong></td>
          <td class="mono small">${esc(p.address)}</td>
          <td>${esc(p.process || '—')}<div class="small muted truncate" style="max-width:220px">${esc(p.cmdline || '')}</div></td>
          <td class="mono">${p.pid ?? '—'}</td>
        </tr>`).join('')}</tbody></table></div>
        ${data.note ? `<div class="small muted mt-1">${esc(data.note)}</div>` : ''}`;
    }

    async function load({ silent = false } = {}) {
      try {
        const net = await api('/api/system/network');
        renderInterfaces(net);
        const ports = await api('/api/system/ports');
        renderPorts(ports);
        if (!silent) diagOut.textContent = 'Choose a target and run a diagnostic. Commands run on the server with its network stack.';
      } catch (err) {
        ifaceBox.innerHTML = `<div class="alert danger">${icon('alert')}<div>${esc(err.message)}</div></div>`;
      }
    }

    root.querySelectorAll('[data-diag]').forEach((btn) => btn.addEventListener('click', () => {
      root.querySelectorAll('[data-diag]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      mode = btn.dataset.diag;
    }));

    root.querySelector('#diag-run').addEventListener('click', async () => {
      const host = diagHost.value.trim();
      if (!host) return;
      diagOut.textContent = `running ${mode} for ${host}…`;
      diagOut.style.borderLeft = '3px solid var(--accent)';
      try {
        if (mode === 'dns') {
          const res = await api(`/api/system/network/dns?host=${encodeURIComponent(host)}`);
          diagOut.textContent = res.ok
            ? `DNS lookup for ${res.host} (${res.elapsed_ms} ms)\n\n${res.records.map((r) => `${r.type.padEnd(5)} ${r.value}`).join('\n')}`
            : `DNS lookup failed for ${res.host}\n\n${res.error}`;
          diagOut.style.borderLeft = `3px solid ${res.ok ? 'var(--success)' : 'var(--danger)'}`;
        } else if (mode === 'ping') {
          const res = await api(`/api/system/network/ping?host=${encodeURIComponent(host)}&count=4`);
          diagOut.textContent = res.output;
          diagOut.style.borderLeft = `3px solid ${res.ok ? 'var(--success)' : 'var(--danger)'}`;
        } else {
          diagOut.textContent = 'running traceroute… (may take up to 60s)';
          const res = await api(`/api/system/network/traceroute?host=${encodeURIComponent(host)}`);
          diagOut.textContent = res.output;
          diagOut.style.borderLeft = `3px solid ${res.ok ? 'var(--success)' : 'var(--danger)'}`;
        }
      } catch (err) {
        diagOut.textContent = err.message;
        diagOut.style.borderLeft = '3px solid var(--danger)';
        toast(err.message, { type: 'error' });
      }
    });

    root.querySelector('#net-refresh').addEventListener('click', () => load());

    await load();
    metricsTimer = setInterval(() => {
      if (document.visibilityState === 'visible') load({ silent: true });
    }, 15000);
    return () => clearInterval(metricsTimer);
  },
};
