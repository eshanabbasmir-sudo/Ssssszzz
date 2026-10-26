// Shared UI primitives: icons, toasts, sheets, dialogs, menus.
import { esc } from './api.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function icon(name, cls = '') {
  return `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

export function setHTML(node, html) {
  node.innerHTML = html;
  return node;
}

export function spinner(label = '') {
  return `<div class="loader"><div class="spinner"></div>${label ? `<p class="muted small mt-2">${esc(label)}</p>` : ''}</div>`;
}

export function skeletonRows(count = 5) {
  return Array.from({ length: count }, () => `
    <div class="list-item" style="cursor:default">
      <div class="skeleton" style="width:26px;height:26px;border-radius:8px"></div>
      <div class="list-main">
        <div class="skeleton skel-line w60"></div>
        <div class="skeleton skel-line w40" style="height:10px"></div>
      </div>
    </div>`).join('');
}

export function emptyState({ icon: iconName = 'info', title = 'Nothing here', text = '' }) {
  return `<div class="empty">${icon(iconName)}<strong>${esc(title)}</strong>${text ? `<span class="small">${esc(text)}</span>` : ''}</div>`;
}

// ------------------------------------------------------------------ toasts
const ICONS = { success: 'check', error: 'alert', warn: 'alert', info: 'info' };

export function toast(message, { type = 'info', title = '', timeout = 4200 } = {}) {
  const host = $('#toast-host');
  if (!host) return;
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.innerHTML = `
    ${icon(ICONS[type] || 'info')}
    <div>
      ${title ? `<div class="toast-title">${esc(title)}</div>` : ''}
      <div class="toast-msg">${esc(message)}</div>
    </div>`;
  host.appendChild(node);
  const remove = () => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 220);
  };
  setTimeout(remove, timeout);
  node.addEventListener('click', remove);
}

// ------------------------------------------------------------------ sheets
export function openSheet({ title, subtitle = '', body, footer = null, size = '', onClose = null, dismissible = true }) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="sheet ${size}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-grip"></div>
      <div class="sheet-head">
        <div style="flex:1;min-width:0">
          <h3>${esc(title)}</h3>
          ${subtitle ? `<div class="sub">${esc(subtitle)}</div>` : ''}
        </div>
        <button class="btn btn-ghost btn-icon btn-sm" data-close aria-label="Close">${icon('x')}</button>
      </div>
      <div class="sheet-body"></div>
      ${footer ? '<div class="sheet-foot"></div>' : ''}
    </div>`;
  const sheet = overlay.querySelector('.sheet');
  const bodyEl = overlay.querySelector('.sheet-body');
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body instanceof Node) bodyEl.appendChild(body);
  if (footer) {
    const footEl = overlay.querySelector('.sheet-foot');
    if (typeof footer === 'string') footEl.innerHTML = footer;
    else footEl.appendChild(footer);
  }
  document.body.appendChild(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && dismissible) close();
  };
  document.addEventListener('keydown', onKey);
  overlay.querySelector('[data-close]').addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && dismissible) close();
  });
  const focusable = overlay.querySelector('input, textarea, button:not([data-close])');
  if (focusable) setTimeout(() => focusable.focus({ preventScroll: true }), 60);
  return { close, overlay, body: bodyEl, footer: overlay.querySelector('.sheet-foot') };
}

export function confirmDialog({
  title = 'Confirm action',
  message = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  requireText = '',
}) {
  return new Promise((resolve) => {
    let input = null;
    const footer = document.createElement('div');
    footer.className = 'row';
    footer.style.width = '100%';
    footer.innerHTML = `
      <div class="spacer"></div>
      <button class="btn btn-soft" data-cancel>${esc(cancelLabel)}</button>
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok ${requireText ? 'disabled' : ''}>${esc(confirmLabel)}</button>`;
    const body = document.createElement('div');
    body.innerHTML = `
      <p class="small" style="color:var(--text-secondary);line-height:1.6">${esc(message)}</p>
      ${requireText ? '<div class="field mt-2"><label>Type <span class="mono">' + esc(requireText) + '</span> to confirm</label><input class="input" data-confirm-input autocomplete="off" spellcheck="false"></div>' : ''}`;
    const sheet = openSheet({ title, body, footer, onClose: () => resolve(false) });
    const ok = footer.querySelector('[data-ok]');
    const cancel = footer.querySelector('[data-cancel]');
    if (requireText) {
      input = body.querySelector('[data-confirm-input]');
      input.addEventListener('input', () => {
        ok.disabled = input.value.trim() !== requireText;
      });
    }
    ok.addEventListener('click', () => { sheet.close(); resolve(true); });
    cancel.addEventListener('click', () => { sheet.close(); resolve(false); });
    setTimeout(() => (input ? input.focus() : ok.focus()), 80);
  });
}

export function promptDialog({
  title = 'Enter a value',
  label = '',
  value = '',
  placeholder = '',
  confirmLabel = 'Save',
  type = 'text',
  multiline = false,
  hint = '',
}) {
  return new Promise((resolve) => {
    const footer = document.createElement('div');
    footer.className = 'row';
    footer.style.width = '100%';
    footer.innerHTML = `<div class="spacer"></div>
      <button class="btn btn-soft" data-cancel>Cancel</button>
      <button class="btn btn-primary" data-ok>${esc(confirmLabel)}</button>`;
    const body = document.createElement('form');
    body.innerHTML = `
      <div class="field">
        ${label ? `<label>${esc(label)}</label>` : ''}
        ${multiline
          ? `<textarea class="textarea" data-input placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
          : `<input class="input" data-input type="${esc(type)}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false">`}
        ${hint ? `<span class="small muted">${esc(hint)}</span>` : ''}
      </div>`;
    const sheet = openSheet({ title, body, footer, onClose: () => resolve(null) });
    const input = body.querySelector('[data-input]');
    const submit = () => {
      const v = input.value;
      if (!v.trim()) { input.focus(); return; }
      sheet.close();
      resolve(v);
    };
    body.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    footer.querySelector('[data-ok]').addEventListener('click', submit);
    footer.querySelector('[data-cancel]').addEventListener('click', () => { sheet.close(); resolve(null); });
    setTimeout(() => { input.focus(); input.select(); }, 80);
  });
}

// ------------------------------------------------------------------ menus
export function actionMenu(anchor, items) {
  const existing = $('#ctx-menu');
  if (existing) existing.remove();
  const menu = document.createElement('div');
  menu.id = 'ctx-menu';
  menu.style.cssText = `position:fixed;z-index:250;min-width:190px;background:var(--surface-strong);
    border:1px solid var(--border);border-radius:var(--r-md);box-shadow:var(--shadow-lg);
    padding:6px;backdrop-filter:blur(24px);animation:viewIn 140ms var(--ease)`;
  items.filter(Boolean).forEach((item) => {
    const btn = document.createElement('button');
    btn.className = 'nav-item';
    btn.style.cssText = 'min-height:38px;font-size:13.5px';
    if (item.danger) { btn.style.color = 'var(--danger)'; }
    btn.innerHTML = `${icon(item.icon || 'more', 'icon-sm')}<span>${esc(item.label)}</span>`;
    btn.addEventListener('click', () => { menu.remove(); item.action(); });
    menu.appendChild(btn);
  });
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth || 190;
  const height = menu.offsetHeight || 100;
  let left = Math.min(rect.right - width, window.innerWidth - width - 10);
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - 10) top = Math.max(10, rect.top - height - 6);
  menu.style.left = `${Math.max(10, left)}px`;
  menu.style.top = `${top}px`;
  const close = (e) => {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close, true); }
  };
  setTimeout(() => document.addEventListener('click', close, true), 0);
  return menu;
}

// ------------------------------------------------------------------ charts
export function sparkline(canvas, values, { color = null, fill = true, max = null } = {}) {
  if (!canvas || !values || values.length < 2) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 240;
  const h = canvas.clientHeight || 46;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const style = getComputedStyle(document.documentElement);
  const stroke = color || style.getPropertyValue('--accent').trim() || '#0a84ff';
  const top = max ?? Math.max(...values, 1);
  const step = w / (values.length - 1);
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = i * step;
    const y = h - 3 - (Math.max(0, v) / top) * (h - 8);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.8;
  ctx.lineJoin = 'round';
  ctx.stroke();
  if (fill) {
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, stroke.replace(')', ', 0.22)').replace('rgb', 'rgba'));
    grad.addColorStop(1, 'transparent');
    if (stroke.startsWith('#')) {
      const r = parseInt(stroke.slice(1, 3), 16);
      const g = parseInt(stroke.slice(3, 5), 16);
      const b = parseInt(stroke.slice(5, 7), 16);
      grad.addColorStop(0, `rgba(${r},${g},${b},0.24)`);
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    }
    ctx.fillStyle = grad;
    ctx.fill();
  }
}

export function setRing(node, percent, { dangerAt = 90, warnAt = 75 } = {}) {
  const circle = node.querySelector('.value');
  const label = node.querySelector('.ring-label');
  const r = 34;
  const circumference = 2 * Math.PI * r;
  if (!circle.dataset.init) {
    circle.style.strokeDasharray = `${circumference}`;
    circle.dataset.init = '1';
  }
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  circle.style.strokeDashoffset = `${circumference * (1 - pct / 100)}`;
  const color = pct >= dangerAt ? 'var(--danger)' : pct >= warnAt ? 'var(--warning)' : 'var(--accent)';
  circle.style.stroke = color;
  if (label) label.textContent = `${Math.round(pct)}%`;
}

export function ringHTML(label = '') {
  return `<div class="ring" aria-label="${esc(label)}">
    <svg viewBox="0 0 84 84"><circle class="track" cx="42" cy="42" r="34"/><circle class="value" cx="42" cy="42" r="34"/></svg>
    <div class="ring-label">0%</div>
  </div>`;
}

export function badgeForStatus(status, sub = '') {
  const active = status === 'active' || status === 'running';
  const failed = status === 'failed' || status === 'dead';
  const cls = active ? 'badge-success' : failed ? 'badge-danger' : 'badge';
  const label = sub ? `${status} · ${sub}` : status;
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

export function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => fallbackCopy(text));
  }
  return Promise.resolve(fallbackCopy(text));
}

function fallbackCopy(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  area.remove();
  return ok;
}
