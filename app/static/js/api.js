// Thin API client: cookie auth + CSRF header + honest error messages.

export class ApiError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

export function cookie(name) {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.*+?^${}()|[\]\\])/g, '\\$1') + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : '';
}

export function onUnauthorized(fn) {
  window.addEventListener('pt:unauthorized', () => fn());
}

async function parseError(res) {
  let detail = `Request failed (${res.status})`;
  try {
    const data = await res.json();
    if (typeof data.detail === 'string') detail = data.detail;
    else if (Array.isArray(data.detail)) detail = data.detail.map((d) => d.msg || JSON.stringify(d)).join('; ');
    else if (data.errors) detail = data.errors.map((e) => `${(e.loc || []).slice(1).join('.')}: ${e.msg}`).join('; ');
  } catch (e) { /* non-JSON error body */ }
  return detail;
}

export async function api(path, options = {}) {
  const { method = 'GET', body, headers = {}, signal, formData } = options;
  const finalHeaders = { Accept: 'application/json', ...headers };
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrf = cookie('pt_csrf');
    if (csrf) finalHeaders['x-csrf-token'] = csrf;
  }
  let payload = body;
  if (formData) {
    payload = formData;
  } else if (body !== undefined && body !== null && typeof body !== 'string') {
    payload = JSON.stringify(body);
    finalHeaders['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(path, { method, headers: finalHeaders, body: payload, credentials: 'same-origin', signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError('Network error — the panel is unreachable.', 0, String(err));
  }
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('pt:unauthorized'));
    throw new ApiError('Your session expired. Please sign in again.', 401);
  }
  if (!res.ok) {
    const detail = await parseError(res);
    throw new ApiError(detail, res.status, detail);
  }
  if (res.status === 204) return null;
  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) return res.json();
  return res.text();
}

export function uploadFile(file, dest, { overwrite = false, onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('dest', dest);
    form.append('overwrite', overwrite ? 'true' : 'false');
    xhr.open('POST', '/api/files/upload');
    const csrf = cookie('pt_csrf');
    if (csrf) xhr.setRequestHeader('x-csrf-token', csrf);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch (e) { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError((data && data.detail) || `Upload failed (${xhr.status})`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('Upload failed: network error', 0));
    xhr.onabort = () => reject(new ApiError('Upload cancelled', 0));
    if (signal) signal.addEventListener('abort', () => xhr.abort());
    xhr.send(form);
  });
}

// ---------------------------------------------------------------- formatting
export function fmtBytes(bytes, digits = 1) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

export function fmtRate(bytesPerSec) {
  if (!bytesPerSec && bytesPerSec !== 0) return '—';
  return `${fmtBytes(bytesPerSec, 1)}/s`;
}

export function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '—';
  seconds = Math.max(0, Math.floor(seconds));
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export function fmtRelative(ts) {
  if (!ts) return '—';
  const diff = Date.now() / 1000 - ts;
  if (diff < 5) return 'just now';
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function wsUrl(path) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}
