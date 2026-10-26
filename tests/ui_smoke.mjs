/**
 * UI smoke test: renders every PRIME TERMINAL view against a live backend in a
 * DOM environment (jsdom) and asserts that real API data reached the markup.
 *
 * It cannot judge visual design, but it catches template errors, broken data
 * bindings, missing elements and JS exceptions in every view.
 *
 * Usage:
 *   npm install jsdom                      # once, in any directory
 *   PRIME_URL=http://127.0.0.1:8080 PRIME_USER=admin PRIME_PASS=... \
 *     node tests/ui_smoke.mjs
 *
 * Requires a running panel (bash panel.sh) and Node 18+.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.PRIME_ROOT || path.join(HERE, '..'));
const BASE = process.env.PRIME_URL || 'http://127.0.0.1:8080';
const USER = process.env.PRIME_USER || 'admin';
const PASS = process.env.PRIME_PASS || '';
const nativeFetch = globalThis.fetch;

if (!PASS) {
  console.error('Set PRIME_PASS to the panel password.');
  process.exit(2);
}

// --- copy the ES modules somewhere Node will treat them as ESM ---------------
const jsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-js-'));
fs.cpSync(path.join(ROOT, 'app/static/js'), jsDir, { recursive: true });
fs.writeFileSync(path.join(jsDir, 'package.json'), '{"type":"module"}');

const loginRes = await nativeFetch(BASE + '/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
});
if (!loginRes.ok) {
  console.error('Login failed:', loginRes.status, await loginRes.text());
  process.exit(2);
}
const cookies = loginRes.headers.getSetCookie().map((c) => c.split(';')[0]);
const csrf = cookies.find((c) => c.startsWith('pt_csrf=')).split('=')[1];

// --- DOM --------------------------------------------------------------------
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (err) => {
  if (!/Not implemented/.test(err.message)) console.error('[jsdom]', err.message);
});
const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'app/static/index.html'), 'utf8'), {
  url: BASE + '/',
  pretendToBeVisual: true,
  virtualConsole,
});
const { window } = dom;
window.document.cookie = `pt_csrf=${csrf}`;

class FakeCanvasCtx {
  setTransform() {} clearRect() {} beginPath() {} moveTo() {} lineTo() {}
  stroke() {} fill() {} closePath() { return { addColorStop() {} }; }
  createLinearGradient() { return { addColorStop() {} }; }
}
window.HTMLCanvasElement.prototype.getContext = () => new FakeCanvasCtx();
class FakeTerminal {
  constructor(opts = {}) { this.options = opts; this.cols = 100; this.rows = 30; }
  open() {} loadAddon() {} write() {} onData() {} onResize() {}
  attachCustomKeyEventHandler() {} reset() {} focus() {} dispose() {}
  hasSelection() { return false; } getSelection() { return ''; } clear() {}
}
class FakeWebSocket {
  constructor() {
    this.readyState = 0;
    setTimeout(() => {
      this.readyState = 1;
      this.onopen && this.onopen();
      this.onmessage && this.onmessage({ data: JSON.stringify({ type: 'ready', pid: 1, shell: '/bin/bash' }) });
    }, 5);
  }
  send() {} close() { this.onclose && this.onclose({ code: 1000 }); }
}
Object.assign(window, {
  ResizeObserver: class { observe() {} disconnect() {} },
  Terminal: FakeTerminal,
  FitAddon: { FitAddon: class { fit() {} } },
  WebLinksAddon: { WebLinksAddon: class {} },
  WebSocket: FakeWebSocket,
});
window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {} }));
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? (input.startsWith('http') ? input : BASE + input) : input.url;
  const headers = new Headers(init.headers || {});
  headers.set('Cookie', cookies.join('; '));
  return nativeFetch(url, { ...init, headers });
};
for (const key of ['window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage', 'history',
  'HTMLElement', 'Node', 'Element', 'Event', 'CustomEvent', 'Headers', 'Request', 'Response', 'FormData',
  'Blob', 'URL', 'URLSearchParams', 'XMLHttpRequest', 'FileReader', 'TextEncoder', 'getComputedStyle',
  'matchMedia', 'ResizeObserver', 'requestAnimationFrame', 'DOMException']) {
  if (window[key] === undefined) continue;
  try { globalThis[key] = window[key]; } catch { Object.defineProperty(globalThis, key, { value: window[key], configurable: true }); }
}
globalThis.fetch = window.fetch;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail ? '  ' + detail : '')); }
};
const ctx = (params = {}) => ({
  params: new URLSearchParams(params),
  user: { username: USER, is_admin: true },
  navigate() {},
  overview: null,
  refreshOverview: async () => null,
});

const views = [
  ['dashboard', ['Host', 'CPU usage', 'Memory', 'Disk', 'Network']],
  ['files', ['Upload', 'Name', 'Modified']],
  ['processes', ['PID', 'CPU %']],
  ['services', ['systemd']],
  ['packages', ['Package', 'installed']],
  ['network', ['Interfaces', 'Listening ports', 'Diagnostics']],
  ['logs', ['Sources', 'systemd journal']],
  ['python', ['Script', 'Output', 'Run script']],
  ['ssh', ['authorized_keys']],
  ['settings', ['Account', 'Security', 'Appearance']],
  ['terminal', ['term-frame', 'Esc', 'Ctrl+C']],
];

console.log('\n== PRIME TERMINAL UI smoke test ==');
for (const [name, expected] of views) {
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  let cleanup = null;
  try {
    const mod = await import(pathToFileURL(path.join(jsDir, 'views', `${name}.js`)).href);
    cleanup = await mod.default.render(container, ctx());
    await sleep(800);
    const html = container.innerHTML;
    const missing = expected.filter((token) => !html.includes(token));
    check(`view ${name} renders`, container.children.length > 0);
    check(`view ${name} shows expected content`, missing.length === 0, 'missing: ' + missing.join(', '));
    if (name === 'dashboard') check('dashboard shows live CPU value', /\d+(\.\d+)?%/.test(container.textContent));
    if (name === 'files') check('file list has rows', container.querySelectorAll('.file-row[data-path]').length > 0);
    if (name === 'processes') check('process table has rows', container.querySelectorAll('tbody tr[data-pid]').length > 0);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL  view ${name} threw: ${err && err.message}`);
  } finally {
    if (typeof cleanup === 'function') cleanup();
    container.remove();
  }
}
// --- application shell: routing, navigation, theme --------------------------
console.log('\n== App shell (router, navigation, theme) ==');
try {
  window.location.hash = '#/dashboard';
  await import(pathToFileURL(path.join(jsDir, 'app.js')).href);
  await sleep(2500);
  const doc = window.document;
  check('sidebar navigation built', doc.querySelectorAll('#nav-main .nav-item[data-path]').length >= 11);
  check('app shell visible after auth', !doc.querySelector('#app').hidden);
  check('auth screen hidden after login', doc.querySelector('#auth-screen').hidden);
  check('router sets the dashboard title', doc.querySelector('#page-title').textContent === 'Dashboard');
  check('dashboard rendered in the shell', doc.querySelector('#content').textContent.includes('Host'));
  check('bottom navigation built', doc.querySelectorAll('#bottom-nav button').length === 5);

  window.location.hash = '#/processes';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await sleep(1200);
  check('router navigates to processes', doc.querySelector('#page-title').textContent === 'Processes');
  check('routed view shows process rows', doc.querySelectorAll('#content tbody tr[data-pid]').length > 0);

  window.location.hash = '#/settings?tab=panel';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await sleep(1200);
  check('router handles query strings', doc.querySelector('#content').textContent.includes('Capabilities'));

  const before = doc.documentElement.dataset.theme;
  doc.querySelector('#theme-btn').click();
  await sleep(100);
  check('theme toggle switches theme', doc.documentElement.dataset.theme !== before);
} catch (err) {
  fail += 1;
  console.log('  FAIL  app shell threw: ' + (err && err.message));
}

console.log(`\n===== UI: ${pass} passed, ${fail} failed =====`);
fs.rmSync(jsDir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
