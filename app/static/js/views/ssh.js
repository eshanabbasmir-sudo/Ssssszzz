// SSH authorized_keys management.
import { api, esc } from '../api.js';
import { icon, toast, confirmDialog, emptyState, openSheet } from '../ui.js';

export default {
  async render(root) {
    root.innerHTML = `
      <div class="view">
        <div id="ssh-note"></div>
        <div class="toolbar mt-2" style="margin-bottom:12px">
          <div class="btn-group" id="ssh-scope">
            <button data-scope="self" class="active">Panel user</button>
            <button data-scope="root">root</button>
            <button data-scope="custom">Other user…</button>
          </div>
          <div class="spacer"></div>
          <button class="btn btn-soft btn-sm" id="ssh-refresh">${icon('refresh', 'icon-sm')} Refresh</button>
          <button class="btn btn-primary btn-sm" id="ssh-add">${icon('plus', 'icon-sm')} Add key</button>
        </div>
        <div class="card">
          <div class="card-head">${icon('key')}<h3 id="ssh-title">authorized_keys</h3><div class="spacer"></div>
            <span class="badge" id="ssh-writable"></span></div>
          <div class="small muted mono" id="ssh-path" style="margin-bottom:10px"></div>
          <div id="ssh-keys"><div class="loader"><div class="spinner"></div></div></div>
        </div>
        <div class="alert mt-2">${icon('info')}<div>
          Keys are written to <span class="mono">~/.ssh/authorized_keys</span> for the selected user with permissions 600.
          Adding a key grants SSH login to that account — only add keys you control. The panel never weakens sshd configuration.
        </div></div>
      </div>`;

    const keysBox = root.querySelector('#ssh-keys');
    const titleBox = root.querySelector('#ssh-title');
    const pathBox = root.querySelector('#ssh-path');
    const writableBox = root.querySelector('#ssh-writable');
    const noteBox = root.querySelector('#ssh-note');
    let scope = 'self';
    let current = null;

    async function load() {
      keysBox.innerHTML = '<div class="loader"><div class="spinner"></div></div>';
      try {
        const data = await api(`/api/system/ssh/keys?scope=${encodeURIComponent(scope)}`);
        current = data;
        titleBox.textContent = `${data.user} · authorized_keys`;
        pathBox.textContent = data.path;
        writableBox.className = `badge ${data.writable ? 'badge-success' : 'badge-warning'}`;
        writableBox.textContent = data.writable ? 'writable' : 'read-only';
        noteBox.innerHTML = '';
        if (!data.keys.length) {
          keysBox.innerHTML = emptyState({
            icon: 'key',
            title: data.exists ? 'No keys in this file' : 'No authorized_keys file yet',
            text: data.writable ? 'Add a public key to enable SSH access.' : 'The panel cannot write to this file (permissions).',
          });
          return;
        }
        keysBox.innerHTML = `<div class="list">${data.keys.map((k, i) => `
          <div class="list-item" style="cursor:default;align-items:flex-start">
            ${icon('key')}
            <div class="list-main">
              <div class="list-title mono" style="font-size:12px;white-space:normal;word-break:break-all">${esc(k.type)}${k.comment ? ` · ${esc(k.comment)}` : ''}</div>
              <div class="list-sub mono" style="font-size:10.5px;white-space:normal;word-break:break-all">${esc(k.fingerprint || k.raw.slice(0, 90))}</div>
            </div>
            <button class="btn btn-ghost btn-icon btn-sm" data-del="${i}" title="Remove key" ${data.writable ? '' : 'disabled'}>${icon('trash', 'icon-sm')}</button>
          </div>`).join('')}</div>`;
        keysBox.querySelectorAll('[data-del]').forEach((btn) => btn.addEventListener('click', () => removeKey(Number(btn.dataset.del))));
      } catch (err) {
        keysBox.innerHTML = `<div class="alert ${err.status === 403 ? 'warn' : 'danger'}">${icon('alert')}<div>${esc(err.message)}</div></div>`;
        titleBox.textContent = 'authorized_keys';
        pathBox.textContent = '';
        writableBox.textContent = '';
      }
    }

    async function removeKey(index) {
      const key = current?.keys[index];
      const ok = await confirmDialog({
        title: 'Remove SSH key?',
        message: `Remove key${key?.comment ? ` "${key.comment}"` : ''} from ${current.user}'s authorized_keys? Anyone relying on it loses SSH access.`,
        confirmLabel: 'Remove key',
        danger: true,
      });
      if (!ok) return;
      try {
        await api('/api/system/ssh/keys/delete', { method: 'POST', body: { scope, index } });
        toast('Key removed', { type: 'success' });
        load();
      } catch (err) {
        toast(err.message, { type: 'error' });
      }
    }

    function addKeyDialog() {
      if (current && !current.writable) {
        toast('This authorized_keys file is not writable by the panel.', { type: 'warn' });
        return;
      }
      const body = document.createElement('div');
      body.innerHTML = `
        <div class="field">
          <label>Public key</label>
          <textarea class="textarea" id="ssh-new" placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA… user@host" spellcheck="false" style="height:130px"></textarea>
          <span class="small muted">Paste a single line: ssh-ed25519 / ssh-rsa / ecdsa-sha2-nistp256 / sk-ssh-ed25519 keys are accepted.</span>
        </div>
        <div class="field mt-2">
          <label>Target</label>
          <input class="input mono" value="${esc(current?.user || scope)}" disabled>
        </div>`;
      const footer = document.createElement('div');
      footer.className = 'row';
      footer.style.width = '100%';
      footer.innerHTML = `<div class="spacer"></div><button class="btn btn-soft" data-cancel>Cancel</button>
        <button class="btn btn-primary" data-save>Authorize key</button>`;
      const sheet = openSheet({ title: 'Add SSH public key', body, footer });
      footer.querySelector('[data-cancel]').addEventListener('click', () => sheet.close());
      footer.querySelector('[data-save]').addEventListener('click', async () => {
        const key = body.querySelector('#ssh-new').value.trim();
        if (!key) return;
        try {
          await api('/api/system/ssh/keys', { method: 'POST', body: { scope, key } });
          toast('Key authorised', { type: 'success' });
          sheet.close();
          load();
        } catch (err) {
          toast(err.message, { type: 'error' });
        }
      });
    }

    root.querySelectorAll('[data-scope]').forEach((btn) => btn.addEventListener('click', () => {
      const next = btn.dataset.scope;
      if (next === 'custom') {
        const user = window.prompt('Username whose authorized_keys should be managed:');
        if (!user) return;
        scope = user.trim();
      } else {
        scope = next;
      }
      root.querySelectorAll('[data-scope]').forEach((b) => b.classList.toggle('active', b === btn));
      load();
    }));

    root.querySelector('#ssh-refresh').addEventListener('click', load);
    root.querySelector('#ssh-add').addEventListener('click', addKeyDialog);

    await load();
    return () => {};
  },
};
