// PRIME TERMINAL — application shell, routing and authentication flow.
import { api, esc, onUnauthorized } from './api.js';
import { $, $$, icon, toast, openSheet, copyToClipboard } from './ui.js';

import dashboard from './views/dashboard.js';
import terminalView from './views/terminal.js';
import filesView from './views/files.js';
import processesView from './views/processes.js';
import servicesView from './views/services.js';
import packagesView from './views/packages.js';
import networkView from './views/network.js';
import logsView from './views/logs.js';
import pythonView from './views/python.js';
import sshView from './views/ssh.js';
import settingsView from './views/settings.js';

const routes = [
  { path: '/dashboard', title: 'Dashboard', subtitle: 'Live host overview', icon: 'grid', group: 'Overview', view: dashboard },
  { path: '/terminal', title: 'Terminal', subtitle: 'Real PTY shell on this server', icon: 'terminal', group: 'Control', view: terminalView },
  { path: '/files', title: 'Files', subtitle: 'Browse and edit the filesystem', icon: 'folder', group: 'Control', view: filesView },
  { path: '/processes', title: 'Processes', subtitle: 'Inspect and signal real processes', icon: 'activity', group: 'Control', view: processesView },
  { path: '/services', title: 'Services', subtitle: 'systemd unit status and control', icon: 'server', group: 'Control', view: servicesView },
  { path: '/packages', title: 'Packages', subtitle: 'Installed packages and package manager', icon: 'box', group: 'System', view: packagesView },
  { path: '/network', title: 'Network', subtitle: 'Interfaces, ports and diagnostics', icon: 'globe', group: 'System', view: networkView },
  { path: '/logs', title: 'Logs', subtitle: 'System, service and panel logs', icon: 'file-text', group: 'System', view: logsView },
  { path: '/python', title: 'Python', subtitle: 'Run scripts on the server', icon: 'code', group: 'System', view: pythonView },
  { path: '/ssh', title: 'SSH Keys', subtitle: 'Manage authorized_keys safely', icon: 'key', group: 'System', view: sshView },
  { path: '/settings', title: 'Settings', subtitle: 'Account, security and panel info', icon: 'settings', group: 'System', view: settingsView },
];

const MOBILE_TABS = ['/dashboard', '/terminal', '/files', '/processes'];

const state = {
  user: null,
  overview: null,
  current: null,
  cleanup: null,
  params: new URLSearchParams(),
};

// ------------------------------------------------------------------ routing
function parseHash() {
  const raw = (location.hash || '#/dashboard').slice(1);
  const [path, qs] = raw.split('?');
  return { path: path || '/dashboard', params: new URLSearchParams(qs || '') };
}

function routeFor(path) {
  return routes.find((r) => r.path === path) || routes[0];
}

async function navigate({ initial = false } = {}) {
  if (!state.user) return;
  const { path, params } = parseHash();
  const route = routeFor(path);
  state.params = params;
  if (typeof state.cleanup === 'function') {
    try { state.cleanup(); } catch (e) { console.warn('cleanup failed', e); }
  }
  state.cleanup = null;
  state.current = route;

  $('#page-title').textContent = route.title;
  $('#page-subtitle').textContent = route.subtitle;
  document.title = `${route.title} · PRIME TERMINAL`;
  $$('.nav-item[data-path]').forEach((el) => el.classList.toggle('active', el.dataset.path === route.path));
  $$('.bottom-nav button[data-path]').forEach((el) => el.classList.toggle('active', el.dataset.path === route.path));

  const content = $('#content');
  content.scrollTop = 0;
  content.innerHTML = '';
  try {
    const cleanup = await route.view.render(content, {
      params,
      user: state.user,
      navigate: (hash) => { location.hash = hash; },
      overview: state.overview,
      refreshOverview,
    });
    if (typeof cleanup === 'function') state.cleanup = cleanup;
    else if (cleanup && typeof cleanup.destroy === 'function') state.cleanup = () => cleanup.destroy();
  } catch (err) {
    if (err.status === 401) return;
    console.error(err);
    content.innerHTML = `<div class="view"><div class="card"><div class="alert danger">
      ${icon('alert')}<div><strong>This view failed to load.</strong><div class="small mt-1">${esc(err.message || err)}</div></div>
    </div></div></div>`;
  }
  closeSidebar();
}

function buildNav() {
  const groups = [];
  routes.forEach((r) => {
    let g = groups.find((x) => x.name === r.group);
    if (!g) { g = { name: r.group, items: [] }; groups.push(g); }
    g.items.push(r);
  });
  const nav = $('#nav-main');
  nav.innerHTML = groups.map((g) => `
    <div class="nav-label">${esc(g.name)}</div>
    ${g.items.map((r) => `
      <button class="nav-item" data-path="${esc(r.path)}" type="button">
        ${icon(r.icon)}<span>${esc(r.title)}</span>
      </button>`).join('')}
  `).join('');
  nav.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => { location.hash = `#${btn.dataset.path}`; });
  });
}

function buildBottomNav() {
  const nav = $('#bottom-nav');
  const extra = routes.filter((r) => !MOBILE_TABS.includes(r.path));
  nav.innerHTML = [
    ...MOBILE_TABS.map((path) => {
      const r = routeFor(path);
      return `<button type="button" data-path="${esc(r.path)}">${icon(r.icon)}<span>${esc(r.title)}</span></button>`;
    }),
    `<button type="button" data-more="1">${icon('more')}<span>More</span></button>`,
  ].join('');
  nav.querySelectorAll('button[data-path]').forEach((btn) => {
    btn.addEventListener('click', () => { location.hash = `#${btn.dataset.path}`; });
  });
  nav.querySelector('button[data-more]').addEventListener('click', () => {
    const body = document.createElement('div');
    body.className = 'list';
    body.innerHTML = routes.map((r) => `
      <button class="list-item ${state.current?.path === r.path ? 'active' : ''}" data-nav="${esc(r.path)}">
        ${icon(r.icon)}<div class="list-main"><div class="list-title">${esc(r.title)}</div>
        <div class="list-sub">${esc(r.subtitle)}</div></div>${icon('chevron-right', 'icon-sm')}
      </button>`).join('');
    const sheet = openSheet({ title: 'Navigate', body });
    body.querySelectorAll('[data-nav]').forEach((btn) => {
      btn.addEventListener('click', () => {
        sheet.close();
        location.hash = `#${btn.dataset.nav}`;
      });
    });
  });
}

// ------------------------------------------------------------------ sidebar (mobile)
function openSidebar() {
  $('#sidebar').classList.add('open');
  $('#sidebar-scrim').classList.remove('hidden');
}
function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#sidebar-scrim').classList.add('hidden');
}

// ------------------------------------------------------------------ theme
function applyTheme(theme) {
  const resolved = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : theme;
  document.documentElement.dataset.theme = resolved;
  localStorage.setItem('pt-theme', theme);
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = resolved === 'light' ? '#eef1f6' : '#07080b';
  $('#theme-btn').innerHTML = icon(resolved === 'light' ? 'moon' : 'sun');
  $('#theme-btn').title = resolved === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
  window.dispatchEvent(new CustomEvent('pt:theme', { detail: resolved }));
}

window.__ptApplyTheme = applyTheme;

function initTheme() {
  const stored = localStorage.getItem('pt-theme') || 'system';
  applyTheme(stored);
  $('#theme-btn').addEventListener('click', () => {
    const resolved = document.documentElement.dataset.theme;
    applyTheme(resolved === 'light' ? 'dark' : 'light');
  });
}

// ------------------------------------------------------------------ auth
async function refreshOverview() {
  try {
    state.overview = await api('/api/system/overview');
    const host = state.overview.host;
    $('#brand-host').textContent = host.hostname || 'linux control';
    setConnection(true);
  } catch (err) {
    if (err.status === 401) return;
    setConnection(false);
  }
  return state.overview;
}

function setConnection(ok) {
  const dot = $('#side-dot');
  const label = $('#side-status');
  if (!dot || !label) return;
  dot.className = `dot ${ok ? 'pulse' : 'bad'}`;
  label.textContent = ok ? 'Server reachable' : 'Connection lost';
}

function showAuth(mode = 'login') {
  $('#app').hidden = true;
  $('#bottom-nav').hidden = true;
  const screen = $('#auth-screen');
  screen.hidden = false;
  const isSetup = mode === 'setup';
  $('#auth-title').textContent = isSetup ? 'Create admin account' : 'PRIME TERMINAL';
  $('#auth-lead').textContent = isSetup
    ? 'First run — choose credentials for this server'
    : 'Sign in to manage this server';
  $('#auth-confirm-field').classList.toggle('hidden', !isSetup);
  $('#auth-password').setAttribute('autocomplete', isSetup ? 'new-password' : 'current-password');
  $('#auth-submit').textContent = isSetup ? 'Create account & sign in' : 'Sign in';
  $('#auth-note').innerHTML = isSetup
    ? 'The password is hashed with scrypt before it is stored.'
    : 'Protected server access. Failed sign-in attempts are rate limited.';
  screen.dataset.mode = mode;
  $('#auth-error').classList.remove('show');
  setTimeout(() => $('#auth-username').focus({ preventScroll: true }), 120);
}

function authError(message) {
  const box = $('#auth-error');
  box.textContent = message;
  box.classList.add('show');
}

function showApp() {
  $('#auth-screen').hidden = true;
  $('#app').hidden = false;
  $('#bottom-nav').hidden = false;
  $('#brand-host').textContent = state.overview?.host?.hostname || 'linux control';
  const letter = (state.user.username || 'U').slice(0, 1).toUpperCase();
  $('#avatar-btn').textContent = letter;
  $('#avatar-btn').title = state.user.username;
  if (window.innerWidth > 900) $('#sidebar').classList.add('open');
}

async function afterLogin() {
  await refreshOverview();
  showApp();
  buildBottomNav();
  await navigate({ initial: true });
}

async function boot() {
  buildNav();
  initTheme();
  $('#menu-btn').addEventListener('click', openSidebar);
  $('#sidebar-scrim').addEventListener('click', closeSidebar);
  $('#avatar-btn').addEventListener('click', accountMenu);
  window.addEventListener('hashchange', () => navigate());
  window.addEventListener('online', () => setConnection(true));
  window.addEventListener('offline', () => setConnection(false));
  onUnauthorized(() => {
    state.user = null;
    toast('Your session has expired. Please sign in again.', { type: 'warn' });
    showAuth('login');
  });

  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const mode = $('#auth-screen').dataset.mode || 'login';
    const username = $('#auth-username').value.trim();
    const password = $('#auth-password').value;
    const submit = $('#auth-submit');
    $('#auth-error').classList.remove('show');
    if (mode === 'setup') {
      if (password.length < 10) return authError('Password must be at least 10 characters.');
      if (password !== $('#auth-confirm').value) return authError('Passwords do not match.');
    }
    submit.disabled = true;
    submit.textContent = mode === 'setup' ? 'Creating account…' : 'Signing in…';
    try {
      const result = mode === 'setup'
        ? await api('/api/auth/setup', { method: 'POST', body: { username, password } })
        : await api('/api/auth/login', { method: 'POST', body: { username, password } });
      state.user = result.user;
      $('#auth-password').value = '';
      $('#auth-confirm').value = '';
      await afterLogin();
    } catch (err) {
      authError(err.message);
      $('#auth-password').value = '';
      $('#auth-password').focus();
    } finally {
      submit.disabled = false;
      submit.textContent = mode === 'setup' ? 'Create account & sign in' : 'Sign in';
    }
  });

  try {
    const auth = await api('/api/auth/state');
    if (!auth.initialized) {
      showAuth('setup');
      return;
    }
    if (!auth.authenticated) {
      showAuth('login');
      return;
    }
    state.user = auth.user;
    if (!location.hash || location.hash === '#') location.hash = '#/dashboard';
    await afterLogin();
    // light periodic reachability check
    setInterval(() => { if (state.user && document.visibilityState === 'visible') refreshOverview(); }, 60000);
  } catch (err) {
    showAuth('login');
    authError(err.status === 0 ? 'Cannot reach the PRIME TERMINAL backend.' : err.message);
  }

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

function accountMenu() {
  const footer = document.createElement('div');
  footer.className = 'row';
  footer.style.width = '100%';
  footer.innerHTML = `<button class="btn btn-soft btn-block" data-logout>${icon('logout')} Sign out</button>`;
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="row" style="gap:14px;padding:6px 0 14px">
      <div class="avatar" style="width:48px;height:48px;font-size:17px">${esc((state.user.username || 'U').slice(0, 1).toUpperCase())}</div>
      <div>
        <div style="font-weight:650">${esc(state.user.username)}</div>
        <div class="small muted">${state.user.is_admin ? 'Administrator' : 'User'}</div>
      </div>
    </div>
    <div class="h-px"></div>
    <div class="list">
      <button class="list-item" data-go="/settings">${icon('settings')}<div class="list-main"><div class="list-title">Settings</div>
        <div class="list-sub">Account, security, panel details</div></div>${icon('chevron-right', 'icon-sm')}</button>
      <button class="list-item" data-go="/settings?tab=sessions">${icon('lock')}<div class="list-main"><div class="list-title">Active sessions</div>
        <div class="list-sub">Review and revoke sign-ins</div></div>${icon('chevron-right', 'icon-sm')}</button>
      <button class="list-item" data-copy-host>${icon('copy')}<div class="list-main"><div class="list-title">Copy panel URL</div>
        <div class="list-sub">${esc(location.origin)}</div></div></button>
    </div>`;
  const sheet = openSheet({ title: 'Account', body, footer });
  body.querySelectorAll('[data-go]').forEach((btn) => btn.addEventListener('click', () => {
    sheet.close();
    location.hash = `#${btn.dataset.go}`;
  }));
  body.querySelector('[data-copy-host]').addEventListener('click', async () => {
    await copyToClipboard(location.origin);
    toast('Panel URL copied', { type: 'success' });
  });
  footer.querySelector('[data-logout]').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
    state.user = null;
    sheet.close();
    showAuth('login');
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSidebar();
});

boot();
