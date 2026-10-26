// File manager backed by the real filesystem.
import { api, fmtBytes, fmtTime, esc, uploadFile } from '../api.js';
import { icon, toast, confirmDialog, promptDialog, openSheet, actionMenu, emptyState, copyToClipboard, $ } from '../ui.js';

const PAGE = 300;

function fileKind(entry) {
  if (entry.is_dir) return 'dir';
  const name = (entry.name || '').toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/.test(name)) return 'img';
  if (/\.(js|mjs|ts|py|sh|css|html?|json|ya?ml|toml|ini|conf|rs|go|c|h|cpp|java|php|rb|sql|xml|md)$/.test(name)) return 'code';
  if (/\.(mp4|mkv|webm|mp3|wav|flac|ogg|m4a)$/.test(name)) return 'media';
  return 'file';
}

function kindIcon(kind) {
  return { dir: 'folder', img: 'image', code: 'code', media: 'film', file: 'file' }[kind] || 'file';
}

function dirname(path) {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

function joinPath(dir, name) {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

export default {
  async render(root, ctx) {
    let path = ctx.params.get('path') || sessionStorage.getItem('pt-files-path') || '';
    let entries = [];
    let total = 0;
    let offset = 0;
    let hasMore = false;
    let selected = new Set();
    let selectMode = false;
    let query = '';
    let showHidden = true;
    let loading = false;
    let rootInfo = null;
    let capabilities = null;
    let uploadSheet = null;

    root.innerHTML = `
      <div class="view">
        <div class="toolbar" style="margin-bottom:12px">
          <button class="btn btn-icon btn-soft" id="fs-up" title="Parent folder">${icon('chevron-left')}</button>
          <div class="pathbar" id="fs-path"></div>
          <button class="btn btn-icon btn-soft" id="fs-refresh" title="Refresh">${icon('refresh')}</button>
          <button class="btn btn-primary btn-sm" id="fs-upload">${icon('upload', 'icon-sm')} Upload</button>
          <button class="btn btn-soft btn-sm" id="fs-new">${icon('plus', 'icon-sm')} New</button>
          <button class="btn btn-soft btn-sm" id="fs-select">${icon('check', 'icon-sm')} Select</button>
        </div>
        <div class="toolbar" style="margin-bottom:12px">
          <div class="search">
            ${icon('search')}
            <input class="input input-sm" id="fs-search" placeholder="Filter this folder…" autocomplete="off" spellcheck="false">
          </div>
          <button class="chip active" id="fs-hidden" title="Show hidden files">Hidden files</button>
          <div class="spacer"></div>
          <span class="small muted" id="fs-usage"></span>
        </div>
        <div class="hidden" id="fs-bulk" style="margin-bottom:12px">
          <div class="card" style="padding:10px 14px">
            <div class="row">
              <span class="small" id="fs-bulk-count">0 selected</span>
              <div class="spacer"></div>
              <button class="btn btn-sm btn-soft" id="bulk-download">${icon('download', 'icon-sm')} Archive</button>
              <button class="btn btn-sm btn-soft" id="bulk-move">${icon('move', 'icon-sm')} Move</button>
              <button class="btn btn-sm btn-soft" id="bulk-copy">${icon('copy', 'icon-sm')} Copy</button>
              <button class="btn btn-sm btn-danger-soft" id="bulk-delete">${icon('trash', 'icon-sm')} Delete</button>
            </div>
          </div>
        </div>
        <div class="card card-pad-0" id="fs-listcard">
          <div class="file-row" style="padding:10px 14px;border-bottom:1px solid var(--border)">
            <span></span>
            <span class="cell" style="font-size:11px;text-transform:uppercase;letter-spacing:.06em">Name</span>
            <span class="cell right">Size</span>
            <span class="cell right hide-sm">Modified</span>
            <span class="cell right">Actions</span>
          </div>
          <div id="fs-list">${emptyState({ icon: 'folder', title: 'Loading…' })}</div>
          <div class="center" style="padding:12px">
            <button class="btn btn-sm btn-soft hidden" id="fs-more">Load more</button>
          </div>
        </div>
        <div class="dropzone mt-2" id="fs-drop">
          ${icon('upload')}
          <strong style="color:var(--text-secondary);font-size:13.5px">Drop files to upload</strong>
          <span class="small">Files are written to the current folder</span>
        </div>
        <input type="file" id="fs-file-input" multiple class="hidden">
      </div>`;

    const listBox = root.querySelector('#fs-list');
    const pathBox = root.querySelector('#fs-path');
    const moreBtn = root.querySelector('#fs-more');
    const bulkBox = root.querySelector('#fs-bulk');
    const bulkCount = root.querySelector('#fs-bulk-count');
    const usageBox = root.querySelector('#fs-usage');
    const fileInput = root.querySelector('#fs-file-input');

    try {
      capabilities = await api('/api/system/capabilities');
    } catch (e) { capabilities = null; }

    function syncHash() {
      const hash = `#/files${path ? `?path=${encodeURIComponent(path)}` : ''}`;
      history.replaceState(null, '', hash);
      sessionStorage.setItem('pt-files-path', path);
    }

    function renderPath() {
      const parts = path.split('/').filter(Boolean);
      let acc = '';
      const crumbs = [`<button class="seg" data-path="/">/</button>`];
      parts.forEach((part) => {
        acc += `/${part}`;
        crumbs.push(`<span class="sep">›</span><button class="seg" data-path="${esc(acc)}">${esc(part)}</button>`);
      });
      pathBox.innerHTML = crumbs.join('');
      pathBox.querySelectorAll('[data-path]').forEach((btn) => {
        btn.addEventListener('click', () => navigateTo(btn.dataset.path));
      });
      pathBox.scrollLeft = pathBox.scrollWidth;
      root.querySelector('#fs-up').disabled = !path || path === '/' || path === rootInfo?.root;
    }

    function permissionsBadge(entry) {
      if (!entry.mode_string) return '';
      return `<span class="mono" style="font-size:11px" title="${esc(entry.mode_string)}">${esc(entry.mode)}</span>`;
    }

    function filteredEntries() {
      if (!query) return entries;
      const needle = query.toLowerCase();
      return entries.filter((e) => e.name.toLowerCase().includes(needle));
    }

    function renderList() {
      const shown = filteredEntries();
      if (!shown.length) {
        listBox.innerHTML = emptyState({
          icon: query ? 'search' : 'folder',
          title: query ? 'No matches' : 'This folder is empty',
          text: query ? 'Try a different filter.' : 'Upload files or create a new one.',
        });
        moreBtn.classList.toggle('hidden', !hasMore);
        return;
      }
      listBox.innerHTML = shown.map((entry) => {
        const kind = fileKind(entry);
        const selectedCls = selected.has(entry.path) ? 'selected' : '';
        const checkbox = selectMode
          ? `<input type="checkbox" data-check="${esc(entry.path)}" ${selected.has(entry.path) ? 'checked' : ''} style="width:16px;height:16px;accent-color:var(--accent)">`
          : `<span class="file-icon ${kind}">${icon(kindIcon(kind), 'icon-sm')}</span>`;
        return `<div class="list-item file-row ${selectedCls}" data-path="${esc(entry.path)}" data-dir="${entry.is_dir ? '1' : '0'}" style="border-radius:0;min-height:48px">
          ${checkbox}
          <div class="cell" style="min-width:0">
            <div class="truncate" style="color:var(--text);font-size:13.5px;font-weight:500">${esc(entry.name)}${entry.is_symlink ? ' <span class="badge" style="font-size:10px">link</span>' : ''}</div>
            <div class="truncate small muted mono" style="font-size:11px">${esc(entry.mode_string || '')} · ${esc(entry.owner || '')}${entry.error ? ` · ${esc(entry.error)}` : ''}</div>
          </div>
          <div class="cell right">${entry.is_dir ? '—' : esc(fmtBytes(entry.size))}</div>
          <div class="cell right hide-sm" style="font-size:11.5px">${esc(fmtTime(entry.mtime))}</div>
          <div class="cell right">
            <button class="btn btn-ghost btn-icon btn-sm" data-menu="${esc(entry.path)}" title="Actions">${icon('more', 'icon-sm')}</button>
          </div>
        </div>`;
      }).join('');

      listBox.querySelectorAll('.file-row[data-path]').forEach((row) => {
        row.addEventListener('click', (event) => {
          if (event.target.closest('[data-menu]') || event.target.matches('[data-check]')) return;
          const entry = entries.find((e) => e.path === row.dataset.path);
          if (!entry) return;
          if (selectMode) { toggleSelect(entry.path); return; }
          if (entry.is_dir) navigateTo(entry.path);
          else openFile(entry);
        });
      });
      listBox.querySelectorAll('[data-check]').forEach((box) => {
        box.addEventListener('change', () => toggleSelect(box.dataset.check, box.checked));
      });
      listBox.querySelectorAll('[data-menu]').forEach((btn) => {
        btn.addEventListener('click', (event) => {
          event.stopPropagation();
          const entry = entries.find((e) => e.path === btn.dataset.menu);
          if (entry) showEntryMenu(btn, entry);
        });
      });
      moreBtn.classList.toggle('hidden', !hasMore || Boolean(query));
    }

    function renderUsage(usage) {
      if (!usage) { usageBox.textContent = ''; return; }
      usageBox.innerHTML = `${icon('drive', 'icon-sm')} ${fmtBytes(usage.free)} free of ${fmtBytes(usage.total)} (${usage.percent}% used)`;
    }

    function updateBulk() {
      bulkBox.classList.toggle('hidden', !selectMode);
      bulkCount.textContent = `${selected.size} selected`;
      bulkBox.querySelector('#bulk-delete').disabled = selected.size === 0;
      bulkBox.querySelector('#bulk-move').disabled = selected.size === 0;
      bulkBox.querySelector('#bulk-copy').disabled = selected.size === 0;
      bulkBox.querySelector('#bulk-download').disabled = selected.size === 0;
      root.querySelector('#fs-select').classList.toggle('btn-primary', selectMode);
      root.querySelector('#fs-select').classList.toggle('btn-soft', !selectMode);
    }

    function toggleSelect(p, force) {
      if (force === false || (force === undefined && selected.has(p))) selected.delete(p);
      else selected.add(p);
      root.querySelectorAll('[data-check]').forEach((box) => {
        if (box.dataset.check === p) box.checked = selected.has(p);
      });
      root.querySelectorAll('.file-row[data-path]').forEach((row) => {
        if (row.dataset.path === p) row.classList.toggle('selected', selected.has(p));
      });
      updateBulk();
    }

    async function load({ append = false } = {}) {
      if (loading) return;
      loading = true;
      if (!append) {
        offset = 0;
        moreBtn.classList.add('hidden');
        listBox.innerHTML = `<div class="loader"><div class="spinner"></div></div>`;
      }
      try {
        if (!rootInfo) rootInfo = await api('/api/files');
        if (!path) path = rootInfo.home || rootInfo.root;
        const data = await api(`/api/files/list?path=${encodeURIComponent(path)}&offset=${offset}&limit=${PAGE}&show_hidden=${showHidden}`);
        if (append) entries = entries.concat(data.entries);
        else entries = data.entries;
        total = data.total;
        hasMore = data.has_more;
        offset = entries.length;
        renderUsage(data.usage);
        renderPath();
        renderList();
        syncHash();
      } catch (err) {
        if (err.status === 401) return;
        listBox.innerHTML = `<div class="empty">${icon('alert')}<strong>Cannot open this folder</strong>
          <span class="small">${esc(err.message)}</span>
          ${err.status === 403 ? `<button class="btn btn-sm btn-soft mt-2" id="fs-gohome">Go to home folder</button>` : ''}</div>`;
        const homeBtn = listBox.querySelector('#fs-gohome');
        if (homeBtn) homeBtn.addEventListener('click', () => navigateTo(rootInfo?.home || '/'));
        renderPath();
      } finally {
        loading = false;
      }
    }

    function navigateTo(newPath) {
      path = newPath;
      selected.clear();
      query = '';
      root.querySelector('#fs-search').value = '';
      updateBulk();
      load();
    }

    // ---------------------------------------------------------------- file ops
    async function openFile(entry) {
      if (entry.size > 4 * 1024 * 1024 && fileKind(entry) !== 'img') {
        const ok = await confirmDialog({
          title: 'Large file',
          message: `${entry.name} is ${fmtBytes(entry.size)}. The editor is limited to 4 MB for safety. Download it instead?`,
          confirmLabel: 'Download',
        });
        if (ok) downloadPaths([entry.path]);
        return;
      }
      if (fileKind(entry) === 'img') {
        const body = document.createElement('div');
        body.innerHTML = `<img src="/api/files/download?path=${encodeURIComponent(entry.path)}" alt="${esc(entry.name)}"
          style="max-width:100%;border-radius:var(--r-md);display:block;margin:0 auto">
          <div class="small muted mt-2 center">${esc(entry.path)} · ${fmtBytes(entry.size)}</div>`;
        const footer = document.createElement('div');
        footer.className = 'row';
        footer.style.width = '100%';
        footer.innerHTML = `<button class="btn btn-soft" data-edit>${icon('edit', 'icon-sm')} Edit as text</button>
          <div class="spacer"></div><button class="btn btn-primary" data-dl>${icon('download', 'icon-sm')} Download</button>`;
        const sheet = openSheet({ title: entry.name, subtitle: entry.path, body, footer, size: 'wide' });
        footer.querySelector('[data-dl]').addEventListener('click', () => downloadPaths([entry.path]));
        footer.querySelector('[data-edit]').addEventListener('click', () => { sheet.close(); openEditor(entry); });
        return;
      }
      openEditor(entry);
    }

    async function openEditor(entry) {
      let data;
      try {
        data = await api(`/api/files/read?path=${encodeURIComponent(entry.path)}`);
      } catch (err) {
        toast(err.message, { type: 'error', title: 'Cannot open file' });
        return;
      }
      if (data.too_large) {
        toast(`File is ${fmtBytes(data.size)} — larger than the ${fmtBytes(data.max_edit_bytes)} editor limit.`, { type: 'warn' });
        return;
      }
      if (data.is_binary) {
        toast('This looks like a binary file and cannot be edited as text.', { type: 'warn' });
        return;
      }
      const body = document.createElement('div');
      body.innerHTML = `
        <div class="row small muted" style="margin-bottom:8px">
          <span class="mono truncate" style="flex:1">${esc(data.path)}</span>
          <span>${fmtBytes(data.size)}</span>
          ${data.writable ? '' : '<span class="badge badge-warning">read-only</span>'}
        </div>
        <textarea class="textarea" id="editor-area" spellcheck="false" style="height:min(58dvh,520px)"></textarea>`;
      const area = body.querySelector('#editor-area');
      area.value = data.content;
      const footer = document.createElement('div');
      footer.className = 'row';
      footer.style.width = '100%';
      footer.innerHTML = `<span class="small muted" id="editor-stat">${data.encoding.toUpperCase()} · ${data.content.split('\n').length} lines</span>
        <div class="spacer"></div>
        <button class="btn btn-soft" data-cancel>Close</button>
        <button class="btn btn-primary" data-save ${data.writable ? '' : 'disabled'}>${icon('save', 'icon-sm')} Save${navigator.platform.includes('Mac') ? ' ⌘S' : ' Ctrl+S'}</button>`;
      const sheet = openSheet({ title: entry.name, subtitle: 'Text editor', body, footer, size: 'full' });
      const saveBtn = footer.querySelector('[data-save]');
      let dirty = false;
      area.addEventListener('input', () => {
        dirty = true;
        footer.querySelector('#editor-stat').textContent = `${data.encoding.toUpperCase()} · ${area.value.split('\n').length} lines · edited`;
      });
      const doSave = async () => {
        saveBtn.disabled = true;
        try {
          const result = await api('/api/files/write', { method: 'PUT', body: { path: entry.path, content: area.value } });
          dirty = false;
          toast(`Saved ${fmtBytes(result.size)} to ${entry.name}`, { type: 'success' });
          load({ append: false });
        } catch (err) {
          toast(err.message, { type: 'error', title: 'Save failed' });
        } finally {
          saveBtn.disabled = !data.writable;
        }
      };
      saveBtn.addEventListener('click', doSave);
      footer.querySelector('[data-cancel]').addEventListener('click', async () => {
        if (dirty) {
          const ok = await confirmDialog({ title: 'Discard changes?', message: 'Unsaved edits will be lost.', confirmLabel: 'Discard', danger: true });
          if (!ok) return;
        }
        sheet.close();
      });
      const onKey = (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (data.writable) doSave(); }
      };
      area.addEventListener('keydown', onKey);
      sheet.overlay.addEventListener('remove', () => area.removeEventListener('keydown', onKey));
    }

    function saveBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    function downloadPaths(paths) {
      if (!paths.length) return;
      if (paths.length === 1) {
        const entry = entries.find((e) => e.path === paths[0]);
        if (entry && entry.is_dir) {
          showDownload(`/api/files/archive?paths=${encodeURIComponent(paths[0])}&name=${encodeURIComponent(entry.name)}`,
            `${entry.name}.zip`, `folder ${entry.name}`, null);
          return;
        }
        showDownload(`/api/files/download?path=${encodeURIComponent(paths[0])}`,
          entry ? entry.name : 'download', entry ? fmtBytes(entry.size) : '', entry ? entry.size : null);
        return;
      }
      const qs = paths.map((p) => `paths=${encodeURIComponent(p)}`).join('&');
      showDownload(`/api/files/archive?${qs}&name=selection`, 'selection.zip', `${paths.length} items`, null);
    }

    // Streaming download with real progress (falls back to a direct link if
    // the browser blocks the request for any reason).
    function showDownload(url, filename, subtitle, sizeHint) {
      const body = document.createElement('div');
      body.innerHTML = `
        <div class="small muted" style="margin-bottom:10px">${esc(subtitle || '')}</div>
        <div class="progress"><span style="width:0%"></span></div>
        <div class="row small muted mt-2"><span id="dl-stat">starting…</span><div class="spacer"></div><span id="dl-pct">0%</span></div>`;
      const sheet = openSheet({ title: `Download ${filename}`, body, dismissible: true });
      const bar = body.querySelector('.progress span');
      const pct = body.querySelector('#dl-pct');
      const stat = body.querySelector('#dl-stat');
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url);
      xhr.responseType = 'blob';
      xhr.onprogress = (e) => {
        if (e.lengthComputable) {
          const p = Math.round((e.loaded / e.total) * 100);
          bar.style.width = `${p}%`;
          pct.textContent = `${p}%`;
          stat.textContent = `${fmtBytes(e.loaded)} of ${fmtBytes(e.total)}`;
        } else {
          stat.textContent = `${fmtBytes(e.loaded)} received`;
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          bar.style.width = '100%';
          pct.textContent = '100%';
          stat.textContent = 'saved to your device';
          saveBlob(xhr.response, filename);
          setTimeout(() => sheet.close(), 900);
        } else {
          let detail = `Download failed (${xhr.status})`;
          try {
            const reader = new FileReader();
            reader.onload = () => { toast(reader.result || detail, { type: 'error' }); };
            reader.readAsText(xhr.response);
          } catch (e) { toast(detail, { type: 'error' }); }
          sheet.close();
        }
      };
      xhr.onerror = () => {
        sheet.close();
        toast('Download failed: network error. Trying a direct link…', { type: 'warn' });
        const a = document.createElement('a');
        a.href = url;
        document.body.appendChild(a);
        a.click();
        a.remove();
      };
      xhr.send();
    }

    function showEntryMenu(anchor, entry) {
      actionMenu(anchor, [
        { icon: entry.is_dir ? 'folder' : 'edit', label: entry.is_dir ? 'Open folder' : 'Open / edit', action: () => (entry.is_dir ? navigateTo(entry.path) : openFile(entry)) },
        { icon: 'download', label: entry.is_dir ? 'Download as ZIP' : 'Download', action: () => downloadPaths([entry.path]) },
        { icon: 'edit', label: 'Rename', action: () => renameEntry(entry) },
        { icon: 'copy', label: 'Copy to…', action: () => copyMove(entry, 'copy') },
        { icon: 'move', label: 'Move to…', action: () => copyMove(entry, 'move') },
        { icon: 'lock', label: 'Permissions', action: () => permissionsDialog(entry) },
        { icon: 'copy', label: 'Copy path', action: async () => {
          const ok = await copyToClipboard(entry.path);
          toast(ok ? 'Path copied' : 'Copy not permitted', { type: ok ? 'success' : 'warn' });
        } },
        { icon: 'trash', label: 'Delete', danger: true, action: () => deletePaths([entry.path]) },
      ]);
    }

    async function renameEntry(entry) {
      const name = await promptDialog({ title: 'Rename', label: 'New name', value: entry.name, confirmLabel: 'Rename' });
      if (!name || name === entry.name) return;
      try {
        await api('/api/files/rename', { method: 'POST', body: { path: entry.path, new_name: name } });
        toast('Renamed', { type: 'success' });
        load();
      } catch (err) {
        toast(err.message, { type: 'error' });
      }
    }

    async function copyMove(entry, mode) {
      const dest = await promptDialog({
        title: mode === 'copy' ? 'Copy to…' : 'Move to…',
        label: 'Destination path (full path including new name)',
        value: joinPath(path, entry.name),
        confirmLabel: mode === 'copy' ? 'Copy' : 'Move',
        hint: 'Use an absolute path. The destination must be inside the allowed filesystem root.',
      });
      if (!dest) return;
      try {
        await api(`/api/files/${mode}`, {
          method: 'POST',
          body: { src: entry.path, dest, overwrite: false },
        });
        toast(`${mode === 'copy' ? 'Copied' : 'Moved'} to ${dest}`, { type: 'success' });
        load();
      } catch (err) {
        toast(err.message, { type: 'error' });
      }
    }

    async function deletePaths(paths) {
      const labels = paths.map((p) => p.split('/').pop()).slice(0, 5).join(', ');
      const ok = await confirmDialog({
        title: 'Delete permanently?',
        message: `${paths.length} item(s) (${labels}${paths.length > 5 ? '…' : ''}) will be deleted. Directories are removed recursively. This cannot be undone.`,
        confirmLabel: 'Delete',
        danger: true,
        requireText: paths.length > 3 ? 'delete' : '',
      });
      if (!ok) return;
      try {
        const res = await api('/api/files/delete', { method: 'POST', body: { paths, recursive: true } });
        if (res.errors && res.errors.length) {
          toast(`${res.deleted.length} deleted, ${res.errors.length} failed: ${res.errors[0].error}`, { type: 'warn' });
        } else {
          toast(`${res.deleted.length} item(s) deleted`, { type: 'success' });
        }
        selected.clear();
        updateBulk();
        load();
      } catch (err) {
        toast(err.message, { type: 'error', title: 'Delete failed' });
      }
    }

    function permissionsDialog(entry) {
      const body = document.createElement('div');
      body.innerHTML = `
        <dl class="kv" style="margin-bottom:14px">
          <dt>Path</dt><dd class="mono">${esc(entry.path)}</dd>
          <dt>Type</dt><dd>${entry.is_dir ? 'Directory' : 'File'}${entry.is_symlink ? ' (symlink)' : ''}</dd>
          <dt>Owner</dt><dd>${esc(entry.owner)} (${entry.uid}) : ${esc(entry.group)} (${entry.gid})</dd>
          <dt>Mode</dt><dd class="mono">${esc(entry.mode)} · ${esc(entry.mode_string)}</dd>
          <dt>Modified</dt><dd>${esc(fmtTime(entry.mtime))}</dd>
          <dt>Size</dt><dd>${entry.is_dir ? '—' : fmtBytes(entry.size)}</dd>
        </dl>
        <div class="field">
          <label>Permissions (octal)</label>
          <input class="input mono" id="perm-mode" value="${esc((entry.mode || '644').replace(/^0o/, ''))}" maxlength="4" spellcheck="false">
        </div>
        <div class="grid grid-2 mt-2">
          <div class="field"><label>Owner (uid or name)</label><input class="input mono" id="perm-uid" value="${esc(entry.owner)}" ${capabilities?.root?.is_root ? '' : 'disabled'}></div>
          <div class="field"><label>Group (gid or name)</label><input class="input mono" id="perm-gid" value="${esc(entry.group)}" ${capabilities?.root?.is_root ? '' : 'disabled'}></div>
        </div>
        ${capabilities?.root?.is_root ? '' : '<p class="small muted mt-2">Changing ownership requires the panel to run as root.</p>'}`;
      const footer = document.createElement('div');
      footer.className = 'row';
      footer.style.width = '100%';
      footer.innerHTML = `<div class="spacer"></div><button class="btn btn-soft" data-cancel>Cancel</button>
        <button class="btn btn-primary" data-apply>Apply</button>`;
      const sheet = openSheet({ title: 'File permissions', subtitle: entry.name, body, footer });
      footer.querySelector('[data-cancel]').addEventListener('click', () => sheet.close());
      footer.querySelector('[data-apply]').addEventListener('click', async () => {
        const mode = body.querySelector('#perm-mode').value.trim().replace(/^0o/, '');
        const uid = body.querySelector('#perm-uid').value.trim();
        const gid = body.querySelector('#perm-gid').value.trim();
        try {
          if (/^[0-7]{3,4}$/.test(mode)) {
            await api('/api/files/chmod', { method: 'POST', body: { path: entry.path, mode } });
          } else {
            throw new Error('Mode must be 3 or 4 octal digits, e.g. 644');
          }
          if (capabilities?.root?.is_root && (uid !== entry.owner || gid !== entry.group)) {
            await api('/api/files/chown', { method: 'POST', body: { path: entry.path, uid, gid } });
          }
          toast('Permissions updated', { type: 'success' });
          sheet.close();
          load();
        } catch (err) {
          toast(err.message, { type: 'error' });
        }
      });
    }

    // ---------------------------------------------------------------- uploads
    function chooseFiles() {
      fileInput.value = '';
      fileInput.click();
    }

    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files.length) startUpload(Array.from(fileInput.files));
    });

    async function startUpload(files) {
      if (!files.length) return;
      const body = document.createElement('div');
      body.innerHTML = `<div class="small muted" style="margin-bottom:10px">Uploading to <span class="mono">${esc(path)}</span></div><div id="upload-list"></div>`;
      const list = body.querySelector('#upload-list');
      let overwriteAll = false;
      const footer = document.createElement('div');
      footer.className = 'row';
      footer.style.width = '100%';
      footer.innerHTML = `<label class="checkbox"><input type="checkbox" id="up-overwrite"> Overwrite existing files</label><div class="spacer"></div>
        <button class="btn btn-soft" data-close>Close</button>`;
      if (uploadSheet) uploadSheet.close();
      uploadSheet = openSheet({ title: `Upload ${files.length} file(s)`, body, footer });
      footer.querySelector('[data-close]').addEventListener('click', () => uploadSheet && uploadSheet.close());
      footer.querySelector('#up-overwrite').addEventListener('change', (e) => { overwriteAll = e.target.checked; });

      for (const file of files) {
        const row = document.createElement('div');
        row.className = 'upload-item';
        row.innerHTML = `<div class="name">${esc(file.name)}<div class="small muted">${fmtBytes(file.size)}</div></div>
          <div class="progress thin" style="width:90px"><span style="width:0%"></span></div>
          <span class="small muted" style="width:44px;text-align:right">0%</span>`;
        list.appendChild(row);
        const bar = row.querySelector('.progress span');
        const pct = row.querySelector('span.small');
        try {
          await uploadFile(file, path, {
            overwrite: overwriteAll,
            onProgress: (loaded, totalBytes) => {
              const p = totalBytes ? Math.round((loaded / totalBytes) * 100) : 0;
              bar.style.width = `${p}%`;
              pct.textContent = `${p}%`;
            },
          });
          pct.textContent = 'done';
          pct.style.color = 'var(--success)';
        } catch (err) {
          row.querySelector('.progress').classList.add('danger');
          bar.style.width = '100%';
          pct.textContent = 'failed';
          pct.style.color = 'var(--danger)';
          const msg = document.createElement('div');
          msg.className = 'small';
          msg.style.color = 'var(--danger)';
          msg.textContent = err.message;
          row.appendChild(msg);
        }
      }
      toast('Upload finished', { type: 'success' });
      load();
    }

    // ---------------------------------------------------------------- events
    root.querySelector('#fs-refresh').addEventListener('click', () => load());
    root.querySelector('#fs-up').addEventListener('click', () => navigateTo(dirname(path) || '/'));
    root.querySelector('#fs-upload').addEventListener('click', chooseFiles);

    root.querySelector('#fs-new').addEventListener('click', (e) => {
      actionMenu(e.currentTarget, [
        { icon: 'folder-plus', label: 'New folder', action: async () => {
          const name = await promptDialog({ title: 'New folder', label: 'Folder name', placeholder: 'my-project', confirmLabel: 'Create' });
          if (!name) return;
          try {
            await api('/api/files/create', { method: 'POST', body: { path: joinPath(path, name), kind: 'dir' } });
            toast('Folder created', { type: 'success' });
            load();
          } catch (err) { toast(err.message, { type: 'error' }); }
        } },
        { icon: 'file', label: 'New file', action: async () => {
          const name = await promptDialog({ title: 'New file', label: 'File name', placeholder: 'notes.txt', confirmLabel: 'Create' });
          if (!name) return;
          try {
            const res = await api('/api/files/create', { method: 'POST', body: { path: joinPath(path, name), kind: 'file' } });
            toast('File created', { type: 'success' });
            await load();
            openEditor(res.entry);
          } catch (err) { toast(err.message, { type: 'error' }); }
        } },
      ]);
    });

    root.querySelector('#fs-select').addEventListener('click', () => {
      selectMode = !selectMode;
      selected.clear();
      updateBulk();
      renderList();
    });

    root.querySelector('#fs-search').addEventListener('input', (e) => {
      query = e.target.value.trim();
      renderList();
    });

    root.querySelector('#fs-hidden').addEventListener('click', (e) => {
      showHidden = !showHidden;
      e.currentTarget.classList.toggle('active', showHidden);
      load();
    });

    moreBtn.addEventListener('click', () => load({ append: true }));

    bulkBox.querySelector('#bulk-delete').addEventListener('click', () => deletePaths(Array.from(selected)));
    bulkBox.querySelector('#bulk-download').addEventListener('click', () => downloadPaths(Array.from(selected)));
    bulkBox.querySelector('#bulk-move').addEventListener('click', async () => {
      const dest = await promptDialog({ title: 'Move items', label: 'Destination folder', value: path, confirmLabel: 'Move' });
      if (!dest) return;
      for (const p of Array.from(selected)) {
        try {
          await api('/api/files/move', { method: 'POST', body: { src: p, dest: joinPath(dest, p.split('/').pop()), overwrite: false } });
        } catch (err) { toast(`${p}: ${err.message}`, { type: 'error' }); }
      }
      selected.clear();
      updateBulk();
      load();
    });
    bulkBox.querySelector('#bulk-copy').addEventListener('click', async () => {
      const dest = await promptDialog({ title: 'Copy items', label: 'Destination folder', value: path, confirmLabel: 'Copy' });
      if (!dest) return;
      for (const p of Array.from(selected)) {
        try {
          await api('/api/files/copy', { method: 'POST', body: { src: p, dest: joinPath(dest, p.split('/').pop()), overwrite: false } });
        } catch (err) { toast(`${p}: ${err.message}`, { type: 'error' }); }
      }
      selected.clear();
      updateBulk();
      load();
    });

    const drop = root.querySelector('#fs-drop');
    ['dragenter', 'dragover'].forEach((evt) => drop.addEventListener(evt, (e) => {
      e.preventDefault();
      drop.classList.add('over');
    }));
    ['dragleave', 'drop'].forEach((evt) => drop.addEventListener(evt, (e) => {
      e.preventDefault();
      drop.classList.remove('over');
    }));
    drop.addEventListener('drop', (e) => {
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length) startUpload(files);
    });
    drop.addEventListener('click', chooseFiles);

    await load();
    updateBulk();

    return () => {
      if (uploadSheet) { try { uploadSheet.close(); } catch (e) { /* ignore */ } }
    };
  },
};
