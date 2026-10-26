// Terminal view: xterm.js attached to a real PTY over WebSocket.
import { api, esc, wsUrl } from '../api.js';
import { icon, toast, confirmDialog, openSheet } from '../ui.js';

function termTheme() {
  const style = getComputedStyle(document.documentElement);
  const dark = document.documentElement.dataset.theme !== 'light';
  const bg = style.getPropertyValue('--terminal-bg').trim() || (dark ? '#05070b' : '#0b0f16');
  return {
    background: bg,
    foreground: '#e7eef9',
    cursor: '#6fb8ff',
    cursorAccent: bg,
    selectionBackground: 'rgba(74,168,255,0.30)',
    black: '#1b1f27', red: '#ff6b6b', green: '#4ade80', yellow: '#f7c948',
    blue: '#5aa9ff', magenta: '#c084fc', cyan: '#3ee0cf', white: '#dbe3ef',
    brightBlack: '#6b7280', brightRed: '#ff8f8f', brightGreen: '#7ef0a5',
    brightYellow: '#ffd977', brightBlue: '#8cc6ff', brightMagenta: '#d8b4fe',
    brightCyan: '#7ff0e2', brightWhite: '#ffffff',
  };
}

export default {
  async render(root, ctx) {
    root.innerHTML = `
      <div class="view" style="height:100%;display:flex;flex-direction:column;gap:10px;min-height:0">
        <div class="row nowrap" style="gap:8px">
          <div class="chips" id="sessions" style="flex:1;overflow-x:auto;flex-wrap:nowrap;padding-bottom:2px"></div>
          <button class="btn btn-primary btn-sm" id="new-session">${icon('plus', 'icon-sm')} New</button>
        </div>
        <div class="term-frame" id="term-frame">
          <div class="term-head">
            <span class="status"><span class="dot pulse" id="conn-dot"></span><span id="conn-label">connecting…</span></span>
            <span class="badge" id="term-shell" style="background:rgba(255,255,255,.08);color:#cbd5e1"></span>
            <div class="spacer"></div>
            <button class="btn btn-ghost btn-icon btn-sm" id="btn-copy" title="Copy selection">${icon('copy', 'icon-sm')}</button>
            <button class="btn btn-ghost btn-icon btn-sm" id="btn-paste" title="Paste from clipboard">${icon('corner-down', 'icon-sm')}</button>
            <button class="btn btn-ghost btn-icon btn-sm" id="btn-clear" title="Clear screen">${icon('eraser', 'icon-sm')}</button>
            <button class="btn btn-ghost btn-icon btn-sm" id="btn-kill" title="End session">${icon('stop', 'icon-sm')}</button>
            <button class="btn btn-ghost btn-icon btn-sm" id="btn-menu" title="Terminal options">${icon('more', 'icon-sm')}</button>
          </div>
          <div class="term-body" id="term-body"></div>
          <div class="term-keybar" id="keybar">
            ${[
              ['Esc', 'escape'], ['Tab', 'tab'], ['Ctrl+C', 'ctrl-c'], ['Ctrl+D', 'ctrl-d'],
              ['Ctrl+L', 'ctrl-l'], ['↑', 'up'], ['↓', 'down'], ['←', 'left'], ['→', 'right'],
              ['|', 'pipe'], ['~', 'tilde'], ['/', 'slash'], ['-', 'dash'], ['Home', 'home'], ['End', 'end'],
            ].map(([label, key]) => `<button class="term-key" data-key="${key}">${label}</button>`).join('')}
          </div>
          <div class="term-overlay hidden" id="term-overlay">
            <div>
              <div class="spinner lg" id="overlay-spinner"></div>
              <p id="overlay-text" class="mt-2">Connecting…</p>
              <div class="row" style="justify-content:center;margin-top:12px" id="overlay-actions"></div>
            </div>
          </div>
        </div>
      </div>`;

    const sessionsBox = root.querySelector('#sessions');
    const termBody = root.querySelector('#term-body');
    const overlay = root.querySelector('#term-overlay');
    const overlayText = root.querySelector('#overlay-text');
    const overlaySpinner = root.querySelector('#overlay-spinner');
    const overlayActions = root.querySelector('#overlay-actions');
    const connDot = root.querySelector('#conn-dot');
    const connLabel = root.querySelector('#conn-label');
    const shellBadge = root.querySelector('#term-shell');

    let sessions = [];
    let activeId = null;
    let ws = null;
    let term = null;
    let fit = null;
    let reconnectAttempts = 0;
    let reconnectTimer = null;
    let disposed = false;
    let fontSize = Number(localStorage.getItem('pt-term-font') || 13.5);
    let lastSentSize = { cols: 0, rows: 0 };

    function setConn(stateName, detail = '') {
      const map = {
        live: ['dot pulse', 'connected'],
        connecting: ['dot warn pulse', 'connecting…'],
        lost: ['dot bad', 'disconnected'],
        ended: ['dot bad', 'session ended'],
      };
      const [cls, label] = map[stateName] || map.connecting;
      connDot.className = cls;
      connLabel.textContent = detail || label;
    }

    function showOverlay(text, { spinner = true, actions = [] } = {}) {
      overlayText.textContent = text;
      overlaySpinner.style.display = spinner ? '' : 'none';
      overlayActions.innerHTML = '';
      actions.forEach((a) => {
        const btn = document.createElement('button');
        btn.className = `btn ${a.primary ? 'btn-primary' : 'btn-soft'} btn-sm`;
        btn.textContent = a.label;
        btn.addEventListener('click', a.action);
        overlayActions.appendChild(btn);
      });
      overlay.classList.remove('hidden');
    }

    function hideOverlay() {
      overlay.classList.add('hidden');
    }

    // ------------------------------------------------------------- sessions
    async function loadSessions() {
      try {
        const data = await api('/api/terminal/sessions');
        sessions = data.sessions;
        renderSessions();
        return data;
      } catch (err) {
        toast(err.message, { type: 'error' });
        return null;
      }
    }

    function renderSessions() {
      if (!sessions.length) {
        sessionsBox.innerHTML = '<span class="small muted">No live sessions</span>';
        return;
      }
      sessionsBox.innerHTML = sessions.map((s) => `
        <button class="chip ${s.id === activeId ? 'active' : ''}" data-session="${s.id}">
          ${s.alive ? '<span class="dot" style="width:6px;height:6px"></span>' : '<span class="dot bad" style="width:6px;height:6px"></span>'}
          ${esc(s.name)} <span class="muted mono" style="font-size:10.5px">${s.pid || ''}</span>
        </button>`).join('');
      sessionsBox.querySelectorAll('[data-session]').forEach((btn) => {
        btn.addEventListener('click', () => attach(btn.dataset.session));
      });
    }

    async function createSession() {
      try {
        const name = `shell ${sessions.length + 1}`;
        const size = fit && term ? { cols: term.cols, rows: term.rows } : { cols: 100, rows: 30 };
        const session = await api('/api/terminal/sessions', {
          method: 'POST',
          body: { name, cols: size.cols, rows: size.rows },
        });
        await loadSessions();
        await attach(session.id);
      } catch (err) {
        toast(err.message, { type: 'error', title: 'Cannot start shell' });
      }
    }

    function initTerm() {
      if (term) return;
      term = new window.Terminal({
        cursorBlink: true,
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono') ||
          'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize,
        lineHeight: 1.25,
        letterSpacing: 0,
        scrollback: 8000,
        allowProposedApi: true,
        theme: termTheme(),
        macOptionIsMeta: true,
        convertEol: false,
        rightClickSelectsWord: true,
      });
      fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
      try {
        term.loadAddon(new window.WebLinksAddon.WebLinksAddon());
      } catch (e) { /* optional addon */ }
      term.open(termBody);
      if (window.innerWidth <= 900) term.options.fontSize = Math.min(fontSize, 12.5);
      safeFit();

      term.onData((data) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data }));
        }
      });
      term.onResize(({ cols, rows }) => {
        if (ws && ws.readyState === WebSocket.OPEN && (cols !== lastSentSize.cols || rows !== lastSentSize.rows)) {
          lastSentSize = { cols, rows };
          ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        }
      });
      term.attachCustomKeyEventHandler((event) => {
        if ((event.ctrlKey || event.metaKey) && event.type === 'keydown') {
          if (event.key === 'c' && term.hasSelection()) {
            navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
            return false;
          }
          if (event.key === 'v' && (event.ctrlKey || event.metaKey)) {
            navigator.clipboard?.readText().then((text) => {
              if (text && ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'input', data: text }));
              }
            }).catch(() => {});
            return false;
          }
        }
        return true;
      });
    }

    function safeFit() {
      if (!fit) return;
      try { fit.fit(); } catch (e) { /* container not visible */ }
      if (term && term.cols && term.rows) {
        lastSentSize = { cols: 0, rows: 0 };
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
          lastSentSize = { cols: term.cols, rows: term.rows };
        }
      }
    }

    function closeSocket() {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (ws) {
        try { ws.onclose = null; ws.close(1000); } catch (e) { /* ignore */ }
        ws = null;
      }
    }

    async function attach(sessionId) {
      if (disposed) return;
      closeSocket();
      activeId = sessionId;
      initTerm();
      term.reset();
      renderSessions();
      hideOverlay();
      setConn('connecting');
      overlaySpinner.style.display = '';
      showOverlay('Connecting to session…');
      safeFit();

      const cols = term.cols || 100;
      const rows = term.rows || 30;
      const socket = new WebSocket(wsUrl(`/ws/terminal/${sessionId}?cols=${cols}&rows=${rows}`));
      socket.binaryType = 'arraybuffer';
      ws = socket;

      socket.onopen = () => { reconnectAttempts = 0; };

      socket.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          term.write(new Uint8Array(event.data));
          return;
        }
        let msg;
        try { msg = JSON.parse(event.data); } catch (e) { term.write(event.data); return; }
        if (msg.type === 'ready') {
          hideOverlay();
          setConn('live', `connected · pid ${msg.pid ?? '?'}`);
          shellBadge.textContent = msg.shell || '';
          term.focus();
          safeFit();
        } else if (msg.type === 'exit') {
          setConn('ended', `session ended${msg.code !== null && msg.code !== undefined ? ` (code ${msg.code})` : ''}`);
          showOverlay(`Shell exited${msg.code !== null && msg.code !== undefined ? ` with code ${msg.code}` : ''}.`, {
            spinner: false,
            actions: [
              { label: 'New session', primary: true, action: () => createSession() },
              { label: 'Sessions', action: () => loadSessions() },
            ],
          });
          loadSessions();
        }
      };

      socket.onclose = (event) => {
        if (disposed || ws !== socket) return;
        ws = null;
        if (event.code === 4401) {
          setConn('lost', 'auth required');
          showOverlay('Your session expired. Reload the page and sign in again.', { spinner: false });
          return;
        }
        if (event.code === 4404) {
          setConn('ended', 'session not found');
          showOverlay('This terminal session no longer exists.', {
            spinner: false,
            actions: [{ label: 'New session', primary: true, action: () => createSession() }],
          });
          return;
        }
        if (event.code === 1000) return;
        setConn('lost');
        reconnectAttempts += 1;
        if (reconnectAttempts <= 3) {
          showOverlay(`Connection lost. Reconnecting (attempt ${reconnectAttempts}/3)…`);
          reconnectTimer = setTimeout(() => attach(sessionId), Math.min(4000, 600 * reconnectAttempts));
        } else {
          showOverlay('Connection lost.', {
            spinner: false,
            actions: [{ label: 'Reconnect', primary: true, action: () => { reconnectAttempts = 0; attach(sessionId); } }],
          });
        }
      };

      socket.onerror = () => {
        setConn('lost');
      };
    }

    // ------------------------------------------------------------- controls
    root.querySelector('#new-session').addEventListener('click', createSession);

    root.querySelector('#btn-clear').addEventListener('click', () => {
      if (term) term.clear();
      term?.focus();
    });

    root.querySelector('#btn-copy').addEventListener('click', async () => {
      const selection = term?.getSelection();
      if (!selection) { toast('Select text in the terminal first.', { type: 'info' }); return; }
      try { await navigator.clipboard.writeText(selection); toast('Copied', { type: 'success' }); }
      catch (e) { toast('Clipboard unavailable — long-press to copy.', { type: 'warn' }); }
    });

    root.querySelector('#btn-paste').addEventListener('click', async () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        const text = await navigator.clipboard.readText();
        if (text) ws.send(JSON.stringify({ type: 'input', data: text }));
      } catch (e) {
        toast('Clipboard read blocked by the browser.', { type: 'warn' });
      }
      term?.focus();
    });

    root.querySelector('#btn-kill').addEventListener('click', async () => {
      if (!activeId) return;
      const ok = await confirmDialog({
        title: 'End terminal session?',
        message: 'The shell process and anything running inside it will be terminated.',
        confirmLabel: 'End session',
        danger: true,
      });
      if (!ok) return;
      try {
        await api(`/api/terminal/sessions/${activeId}`, { method: 'DELETE' });
        closeSocket();
        setConn('ended', 'session closed');
        showOverlay('Session closed.', { spinner: false, actions: [{ label: 'New session', primary: true, action: () => createSession() }] });
        activeId = null;
        await loadSessions();
      } catch (err) {
        toast(err.message, { type: 'error' });
      }
    });

    root.querySelector('#btn-menu').addEventListener('click', (event) => {
      const body = document.createElement('div');
      body.innerHTML = `
        <div class="list">
          <button class="list-item" data-act="font-up">${icon('plus')}<div class="list-main"><div class="list-title">Increase font size</div>
            <div class="list-sub">Currently ${fontSize}px</div></div></button>
          <button class="list-item" data-act="font-down">${icon('minus')}<div class="list-main"><div class="list-title">Decrease font size</div>
            <div class="list-sub">Currently ${fontSize}px</div></div></button>
          <button class="list-item" data-act="reset-font">${icon('refresh')}<div class="list-main"><div class="list-title">Reset font size</div>
            <div class="list-sub">Back to 13.5px</div></div></button>
          <button class="list-item" data-act="reconnect">${icon('refresh')}<div class="list-main"><div class="list-title">Reconnect</div>
            <div class="list-sub">Re-attach to the same session</div></div></button>
          <button class="list-item" data-act="sessions">${icon('list')}<div class="list-main"><div class="list-title">All sessions</div>
            <div class="list-sub">${sessions.length} session(s)</div></div></button>
        </div>`;
      const sheet = openSheet({ title: 'Terminal options', body });
      body.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', async () => {
        const act = btn.dataset.act;
        sheet.close();
        if (act === 'font-up') fontSize = Math.min(24, fontSize + 1);
        if (act === 'font-down') fontSize = Math.max(9, fontSize - 1);
        if (act === 'reset-font') fontSize = 13.5;
        if (act.startsWith('font') || act === 'reset-font') {
          localStorage.setItem('pt-term-font', String(fontSize));
          if (term) { term.options.fontSize = fontSize; safeFit(); }
        }
        if (act === 'reconnect' && activeId) { reconnectAttempts = 0; attach(activeId); }
        if (act === 'sessions') await loadSessions();
      }));
    });

    const keyMap = {
      escape: '\u001b', tab: '\t', 'ctrl-c': '\u0003', 'ctrl-d': '\u0004', 'ctrl-l': '\u000c',
      up: '\u001b[A', down: '\u001b[B', right: '\u001b[C', left: '\u001b[D',
      pipe: '|', tilde: '~', slash: '/', dash: '-', home: '\u001b[H', end: '\u001b[F',
    };
    root.querySelectorAll('[data-key]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const data = keyMap[btn.dataset.key];
        if (data && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data }));
          term?.focus();
        }
      });
    });

    const onTheme = () => { if (term) term.options.theme = termTheme(); };
    window.addEventListener('pt:theme', onTheme);

    let resizeTimer = null;
    const ro = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (term && activeId) safeFit(); }, 140);
    });
    ro.observe(root.querySelector('#term-frame'));

    const onWindowResize = () => { safeFit(); };
    window.addEventListener('resize', onWindowResize);
    window.addEventListener('orientationchange', onWindowResize);

    // Pick up an existing session automatically.
    const data = await loadSessions();
    if (!data) return;
    const wanted = ctx.params.get('session');
    const existing = wanted ? data.sessions.find((s) => s.id === wanted && s.alive) : data.sessions.find((s) => s.alive);
    if (existing) {
      await attach(existing.id);
    } else {
      initTerm();
      term.write('\x1b[38;5;245mNo active terminal session. Starting one…\x1b[0m\r\n');
      await createSession();
    }

    return () => {
      disposed = true;
      closeSocket();
      window.removeEventListener('pt:theme', onTheme);
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('orientationchange', onWindowResize);
      ro.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      if (term) { try { term.dispose(); } catch (e) { /* ignore */ } term = null; }
      fit = null;
    };
  },
};
