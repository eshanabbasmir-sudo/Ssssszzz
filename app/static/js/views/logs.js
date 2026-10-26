// Log viewer for real log files and the systemd journal.
import { api, esc, fmtBytes, fmtRelative } from '../api.js';
import { icon, toast, emptyState, openSheet } from '../ui.js';

export default {
  async render(root) {
    root.innerHTML = `
      <div class="view">
        <div class="toolbar" style="margin-bottom:12px">
          <div class="search">${icon('search')}
            <input class="input input-sm" id="log-filter" placeholder="Filter lines" autocomplete="off" spellcheck="false">
          </div>
          <select class="select input-sm" id="log-lines" style="width:auto">
            <option value="200">200 lines</option>
            <option value="500" selected>500 lines</option>
            <option value="1000">1000 lines</option>
            <option value="3000">3000 lines</option>
          </select>
          <button class="btn btn-soft btn-sm" id="log-auto">${icon('clock', 'icon-sm')} Auto</button>
          <button class="btn btn-icon btn-soft" id="log-refresh" title="Reload">${icon('refresh')}</button>
        </div>
        <div id="log-note"></div>
        <div class="grid grid-3 mt-2" style="align-items:start">
          <div class="card card-pad-0" style="grid-column:span 1">
            <div class="card-head" style="padding:14px 14px 6px">${icon('file-text')}<h3>Sources</h3></div>
            <div class="list" id="log-sources" style="max-height:56dvh;overflow:auto;padding:0 6px 8px">
              <div class="loader"><div class="spinner"></div></div>
            </div>
          </div>
          <div class="card" style="grid-column:span 2">
            <div class="card-head">
              ${icon('hard')}<h3 id="log-title">Select a source</h3>
              <div class="spacer"></div>
              <span class="small muted" id="log-meta"></span>
            </div>
            <div class="code-box" id="log-body" style="height:min(56dvh,560px);white-space:pre;font-size:11.5px">Pick a log source on the left.</div>
          </div>
        </div>
      </div>`;

    const sourcesBox = root.querySelector('#log-sources');
    const bodyBox = root.querySelector('#log-body');
    const titleBox = root.querySelector('#log-title');
    const metaBox = root.querySelector('#log-meta');
    const noteBox = root.querySelector('#log-note');
    const filterInput = root.querySelector('#log-filter');
    const linesSelect = root.querySelector('#log-lines');
    let sources = [];
    let journal = { available: false, reason: '' };
    let active = null;
    let content = '';
    let timer = null;

    function renderSources() {
      const items = sources.map((s) => `
        <button class="list-item ${active === s.id ? 'active' : ''}" data-src="${esc(s.id)}">
          ${icon('file-text')}
          <div class="list-main"><div class="list-title">${esc(s.name)}</div>
            <div class="list-sub mono">${esc(s.path)}</div></div>
          <span class="small muted nowrap">${fmtBytes(s.size)}</span>
        </button>`).join('');
      const journalItem = journal.available
        ? `<div class="h-px"></div>
           <button class="list-item" data-journal="1">${icon('layers')}
             <div class="list-main"><div class="list-title">systemd journal</div>
             <div class="list-sub">journalctl, all units</div></div></button>
           <button class="list-item" data-unit="1">${icon('server')}
             <div class="list-main"><div class="list-title">Journal for a unit…</div>
             <div class="list-sub">e.g. nginx.service</div></div></button>`
        : '';
      sourcesBox.innerHTML = (items || '<div class="small muted" style="padding:12px">No log files found in /var/log</div>') + journalItem;
      if (!journal.available) {
        noteBox.innerHTML = `<div class="alert">${icon('info')}<div>The systemd journal is unavailable here (${esc(journal.reason || 'no systemd')}). File logs still work.</div></div>`;
      } else {
        noteBox.innerHTML = '';
      }
      sourcesBox.querySelectorAll('[data-src]').forEach((btn) => btn.addEventListener('click', () => openSource(btn.dataset.src)));
      const jbtn = sourcesBox.querySelector('[data-journal]');
      if (jbtn) jbtn.addEventListener('click', () => openSource('journal'));
      const ubtn = sourcesBox.querySelector('[data-unit]');
      if (ubtn) ubtn.addEventListener('click', () => {
        const unit = window.prompt('Unit name (e.g. ssh.service):', 'nginx.service');
        if (unit) openSource(`journal:${unit.trim()}`);
      });
    }

    function paint() {
      if (!active) {
        bodyBox.textContent = 'Pick a log source on the left.';
        return;
      }
      const needle = filterInput.value.trim().toLowerCase();
      const lines = content.split('\n');
      const filtered = needle ? lines.filter((l) => l.toLowerCase().includes(needle)) : lines;
      bodyBox.textContent = filtered.length ? filtered.join('\n') : '(no matching lines)';
      bodyBox.scrollTop = bodyBox.scrollHeight;
      metaBox.textContent = `${filtered.length}${needle ? `/${lines.length}` : ''} lines`;
    }

    async function openSource(id) {
      active = id;
      renderSources();
      const src = sources.find((s) => s.id === id);
      titleBox.textContent = src ? src.name : id.startsWith('journal:') ? id : 'systemd journal';
      bodyBox.textContent = 'loading…';
      try {
        const res = await api(`/api/system/logs/read?source=${encodeURIComponent(id)}&lines=${linesSelect.value}`);
        content = res.content || '';
        if (src) {
          metaBox.textContent = `${res.lines} lines · ${fmtBytes(res.size)} · modified ${fmtRelative(src.mtime)}`;
        }
        paint();
      } catch (err) {
        bodyBox.textContent = err.message;
        metaBox.textContent = '';
      }
    }

    async function loadSources() {
      try {
        const data = await api('/api/system/logs');
        sources = data.sources || [];
        journal = data.journal || journal;
        renderSources();
      } catch (err) {
        sourcesBox.innerHTML = `<div class="alert danger">${icon('alert')}<div>${esc(err.message)}</div></div>`;
      }
    }

    filterInput.addEventListener('input', paint);
    linesSelect.addEventListener('change', () => { if (active) openSource(active); });
    root.querySelector('#log-refresh').addEventListener('click', () => { loadSources(); if (active) openSource(active); });
    root.querySelector('#log-auto').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      if (timer) {
        clearInterval(timer); timer = null;
        btn.classList.remove('btn-primary'); btn.classList.add('btn-soft');
        toast('Auto-refresh disabled', { type: 'info' });
      } else {
        timer = setInterval(() => { if (active && document.visibilityState === 'visible') openSource(active); }, 5000);
        btn.classList.add('btn-primary'); btn.classList.remove('btn-soft');
        toast('Auto-refresh every 5s', { type: 'info' });
      }
    });

    await loadSources();
    return () => { if (timer) clearInterval(timer); };
  },
};
