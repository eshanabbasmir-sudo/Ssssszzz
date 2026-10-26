// Dashboard: live host metrics from /api/system/overview + /api/system/metrics.
import { api, fmtBytes, fmtDuration, fmtRate, fmtRelative, esc } from '../api.js';
import { icon, ringHTML, setRing, sparkline, skeletonRows, emptyState } from '../ui.js';

const HISTORY = 42;

export default {
  async render(root) {
    root.innerHTML = `
      <div class="view">
        <div class="grid grid-4" id="dash-stats">
          ${['CPU', 'Memory', 'Disk', 'Network'].map((label) => `
            <div class="card stat">
              <div class="stat-top"><div class="stat-icon">${icon('activity')}</div>${label}</div>
              <div class="skeleton skel-line w60" style="height:28px"></div>
              <div class="skeleton skel-line w80" style="height:8px"></div>
            </div>`).join('')}
        </div>
        <div class="grid grid-3 mt-2" style="align-items:start">
          <div class="card" style="grid-column:span 2">
            <div class="card-head">${icon('server')}<h3>Host</h3><div class="spacer"></div>
              <span class="badge" id="dash-badge">loading</span></div>
            <div id="dash-host"><div class="skeleton skel-line w80"></div><div class="skeleton skel-line w60"></div></div>
          </div>
          <div class="card">
            <div class="card-head">${icon('zap')}<h3>Quick actions</h3></div>
            <div class="list" id="dash-actions">
              <button class="list-item" data-go="/terminal">${icon('terminal')}<div class="list-main">
                <div class="list-title">Open terminal</div><div class="list-sub">Real shell session</div></div>${icon('chevron-right', 'icon-sm')}</button>
              <button class="list-item" data-go="/files">${icon('folder')}<div class="list-main">
                <div class="list-title">Browse files</div><div class="list-sub">/ filesystem root</div></div>${icon('chevron-right', 'icon-sm')}</button>
              <button class="list-item" data-go="/processes">${icon('activity')}<div class="list-main">
                <div class="list-title">Processes</div><div class="list-sub">Inspect, signal</div></div>${icon('chevron-right', 'icon-sm')}</button>
              <button class="list-item" data-go="/logs">${icon('file-text')}<div class="list-main">
                <div class="list-title">View logs</div><div class="list-sub">System &amp; service logs</div></div>${icon('chevron-right', 'icon-sm')}</button>
            </div>
          </div>
        </div>
        <div class="grid grid-2 mt-2">
          <div class="card">
            <div class="card-head">${icon('globe')}<h3>Network interfaces</h3><div class="spacer"></div>
              <button class="btn btn-ghost btn-sm" data-go="/network">Details</button></div>
            <div id="dash-net">${skeletonRows(3)}</div>
          </div>
          <div class="card">
            <div class="card-head">${icon('layers')}<h3>Panel</h3></div>
            <div id="dash-panel">${skeletonRows(3)}</div>
          </div>
        </div>
        <div id="dash-note" class="mt-2"></div>
      </div>`;

    root.querySelectorAll('[data-go]').forEach((el) => el.addEventListener('click', () => {
      location.hash = `#${el.dataset.go}`;
    }));

    let history = { cpu: [], mem: [], netIn: [], netOut: [] };
    let timer = null;
    let overviewTimer = null;
    let stopped = false;

    const hostBox = root.querySelector('#dash-host');
    const netBox = root.querySelector('#dash-net');
    const panelBox = root.querySelector('#dash-panel');
    const badge = root.querySelector('#dash-badge');
    const statsBox = root.querySelector('#dash-stats');
    const noteBox = root.querySelector('#dash-note');

    function renderStats(m) {
      const mem = m.memory;
      const disk = m.disk;
      const cpuPct = m.cpu.percent;
      history.cpu.push(cpuPct);
      history.mem.push(mem.percent);
      history.netIn.push(m.network.recv_per_sec);
      history.netOut.push(m.network.sent_per_sec);
      Object.keys(history).forEach((k) => { if (history[k].length > HISTORY) history[k].shift(); });

      const cores = m.cpu_quota_cores ? `${m.cpu_quota_cores} vCPU quota` : `${m.host_cores} cores`;
      const netTotal = m.network.recv_per_sec + m.network.sent_per_sec;
      statsBox.innerHTML = `
        <div class="card stat">
          <div class="stat-top"><div class="stat-icon">${icon('activity')}</div>CPU usage</div>
          <div class="row nowrap" style="gap:14px;align-items:center">
            <div class="stat-value">${cpuPct.toFixed(1)}<small>%</small></div>
            <div class="spacer"></div>
            <div class="ring" style="width:58px;height:58px">
              <svg viewBox="0 0 84 84"><circle class="track" cx="42" cy="42" r="34"/><circle class="value" cx="42" cy="42" r="34"/></svg>
              <div class="ring-label" style="font-size:12px">${Math.round(cpuPct)}%</div>
            </div>
          </div>
          <canvas class="spark" data-spark="cpu"></canvas>
          <div class="stat-foot">${icon('layers', 'icon-sm')}${esc(cores)} · load ${m.load['1'].toFixed(2)}</div>
        </div>
        <div class="card stat">
          <div class="stat-top"><div class="stat-icon purple">${icon('memory')}</div>Memory</div>
          <div class="stat-value">${fmtBytes(mem.used)}<small>/ ${fmtBytes(mem.total)}</small></div>
          <div class="progress ${mem.percent > 90 ? 'danger' : mem.percent > 75 ? 'warn' : ''}"><span style="width:${mem.percent}%"></span></div>
          <canvas class="spark" data-spark="mem"></canvas>
          <div class="stat-foot">${mem.percent.toFixed(1)}% used · ${fmtBytes(mem.available)} available</div>
        </div>
        <div class="card stat">
          <div class="stat-top"><div class="stat-icon teal">${icon('drive')}</div>Disk</div>
          ${disk ? `
            <div class="stat-value">${fmtBytes(disk.used)}<small>/ ${fmtBytes(disk.total)}</small></div>
            <div class="progress ${disk.percent > 90 ? 'danger' : disk.percent > 75 ? 'warn' : 'success'}"><span style="width:${disk.percent}%"></span></div>
            <div class="stat-foot">${esc(disk.path)} · ${fmtBytes(disk.free)} free</div>`
          : `<div class="stat-value">—</div><div class="stat-foot">Disk usage unavailable</div>`}
          <div class="stat-foot">${icon('activity', 'icon-sm')}R ${fmtRate(m.disk_io.read_per_sec)} · W ${fmtRate(m.disk_io.write_per_sec)}</div>
        </div>
        <div class="card stat">
          <div class="stat-top"><div class="stat-icon warn">${icon('wifi')}</div>Network</div>
          <div class="stat-value">${fmtRate(netTotal)}</div>
          <canvas class="spark" data-spark="net"></canvas>
          <div class="stat-foot" style="gap:12px">
            <span>${icon('arrow-down', 'icon-sm')} ${fmtRate(m.network.recv_per_sec)}</span>
            <span>${icon('arrow-up', 'icon-sm')} ${fmtRate(m.network.sent_per_sec)}</span>
          </div>
        </div>`;

      statsBox.querySelectorAll('[data-spark]').forEach((canvas) => {
        if (canvas.dataset.spark === 'cpu') sparkline(canvas, history.cpu, { max: 100 });
        if (canvas.dataset.spark === 'mem') sparkline(canvas, history.mem, { max: 100, color: '#5e5ce6' });
        if (canvas.dataset.spark === 'net') sparkline(canvas, history.netIn, { color: '#00b3a4' });
      });
    }

    function renderOverview(data) {
      const h = data.host;
      const m = data.metrics;
      const c = h.container || {};
      const caps = data.capabilities || {};
      badge.innerHTML = `<span class="dot ${caps.root?.is_root ? 'warn' : ''}"></span>${h.systemd ? 'systemd' : 'no systemd'}`;
      hostBox.innerHTML = `
        <dl class="kv">
          <dt>Hostname</dt><dd class="mono">${esc(h.hostname)}</dd>
          <dt>Operating system</dt><dd>${esc(h.os_name)}</dd>
          <dt>Kernel</dt><dd class="mono">${esc(h.kernel)}</dd>
          <dt>Architecture</dt><dd class="mono">${esc(h.architecture)}</dd>
          <dt>CPU</dt><dd>${esc(h.cpu_model || 'unknown')}<span class="muted"> · ${h.cpu_cores_physical || '?'} physical / ${h.cpu_cores_logical} logical</span></dd>
          <dt>Uptime</dt><dd>${fmtDuration(m.uptime)} <span class="muted">since ${fmtRelative(h.boot_time)}</span></dd>
          <dt>Load average</dt><dd class="mono">${m.load['1'].toFixed(2)} · ${m.load['5'].toFixed(2)} · ${m.load['15'].toFixed(2)}</dd>
          <dt>Primary address</dt><dd class="mono">${esc(data.primary_ip || '—')}</dd>
          <dt>Processes</dt><dd>${m.process_count}</dd>
        </dl>`;

      const ifaces = (data.interfaces || []).filter((i) => i.name !== 'lo').slice(0, 4);
      netBox.innerHTML = ifaces.length ? `<div class="list">${ifaces.map((i) => {
        const v4 = (i.addresses || []).filter((a) => a.family === 'ipv4').map((a) => a.address).join(', ');
        const v6 = (i.addresses || []).filter((a) => a.family === 'ipv6').map((a) => a.address)[0];
        return `<div class="list-item" style="cursor:default">
          <span class="dot ${i.is_up ? '' : 'bad'}"></span>
          <div class="list-main">
            <div class="list-title">${esc(i.name)}</div>
            <div class="list-sub mono">${esc(v4 || v6 || 'no address')}</div>
          </div>
          <div class="small muted nowrap">${fmtRate((i.bytes_recv || 0) / Math.max(1, m.uptime))}</div>
        </div>`;
      }).join('')}</div>` : emptyState({ icon: 'wifi', title: 'No interfaces reported' });

      const p = data.panel || {};
      panelBox.innerHTML = `
        <dl class="kv">
          <dt>Panel version</dt><dd>${esc(p.version || '—')}</dd>
          <dt>Panel uptime</dt><dd>${fmtDuration(p.uptime)}</dd>
          <dt>Data directory</dt><dd class="mono truncate">${esc(data.env?.data_dir || '—')}</dd>
          <dt>Running as</dt><dd>${esc(h.user)}${caps.root?.is_root ? ' <span class="badge badge-warning">root</span>' : ' <span class="badge">unprivileged</span>'}</dd>
          <dt>Terminal sessions</dt><dd>${p.sessions_total ?? 0}</dd>
          <dt>File browser root</dt><dd class="mono">${esc(caps.filesystem?.root || '/')}</dd>
        </dl>`;

      const notes = [];
      if (c.kind || (c.cgroup_version && (c.memory_bytes || c.cpu_cores))) {
        const limits = [];
        if (c.memory_bytes) limits.push(`memory limit ${fmtBytes(c.memory_bytes)}`);
        if (c.cpu_cores) limits.push(`CPU quota ${c.cpu_cores} cores`);
        notes.push(`<div class="alert warn">${icon('info')}<div><strong>Running inside a container${c.kind ? ` (${esc(c.kind)})` : ''}.</strong>
          The metrics above are real but reflect this container, not the physical host.
          ${limits.length ? `<div class="small mt-1">cgroup limits: ${esc(limits.join(' · '))}</div>` : ''}</div></div>`);
      }
      if (caps.services && caps.services.available === false) {
        notes.push(`<div class="alert">${icon('info')}<div><strong>systemd is unavailable.</strong> ${esc(caps.services.reason || '')}</div></div>`);
      }
      if (caps.packages && caps.packages.available === false) {
        notes.push(`<div class="alert">${icon('info')}<div><strong>No package manager detected.</strong> ${esc(caps.packages.reason || '')}</div></div>`);
      }
      noteBox.innerHTML = notes.join('');
      renderStats(m);
    }

    async function tickMetrics() {
      if (stopped || document.visibilityState !== 'visible') return;
      try {
        const m = await api('/api/system/metrics');
        if (stopped) return;
        renderStats(m);
      } catch (err) {
        if (err.status === 401) return;
      }
    }

    async function loadOverview() {
      try {
        const data = await api('/api/system/overview');
        if (stopped) return;
        renderOverview(data);
      } catch (err) {
        if (err.status === 401) return;
        hostBox.innerHTML = `<div class="alert danger">${icon('alert')}<div>${esc(err.message)}</div></div>`;
      }
    }

    await loadOverview();
    timer = setInterval(tickMetrics, 3000);
    overviewTimer = setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      await loadOverview();
    }, 20000);

    const onVis = () => { if (document.visibilityState === 'visible') loadOverview(); };
    document.addEventListener('visibilitychange', onVis);
    const onResize = () => {
      statsBox.querySelectorAll('[data-spark]').forEach((canvas) => {
        if (canvas.dataset.spark === 'cpu') sparkline(canvas, history.cpu, { max: 100 });
        if (canvas.dataset.spark === 'mem') sparkline(canvas, history.mem, { max: 100, color: '#5e5ce6' });
        if (canvas.dataset.spark === 'net') sparkline(canvas, history.netIn, { color: '#00b3a4' });
      });
    };
    window.addEventListener('resize', onResize);

    return () => {
      stopped = true;
      clearInterval(timer);
      clearInterval(overviewTimer);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('resize', onResize);
    };
  },
};
