// Python runner: executes real scripts with the panel's interpreter.
import { api, esc } from '../api.js';
import { icon, toast } from '../ui.js';

const SAMPLES = {
  inspect: `import platform, shutil, os, socket
print("interpreter:", platform.python_version())
print("platform   :", platform.platform())
print("hostname   :", socket.gethostname())
print("cwd        :", os.getcwd())
total, used, free = shutil.disk_usage("/")
print(f"disk       : {used/2**30:.1f} GiB used of {total/2**30:.1f} GiB")
`,
  enumerate: `import os
root = "/"
for name in sorted(os.listdir(root))[:25]:
    path = os.path.join(root, name)
    kind = "dir " if os.path.isdir(path) else "file"
    print(f"{kind} {name}")
`,
  ports: `import socket
for port in (22, 80, 443, 8080):
    s = socket.socket()
    s.settimeout(0.4)
    try:
        s.connect(("127.0.0.1", port))
        print(f"{port}: open")
    except OSError:
        print(f"{port}: closed")
    finally:
        s.close()
`,
};

export default {
  async render(root) {
    root.innerHTML = `
      <div class="view">
        <div class="alert">${icon('info')}<div>
          Scripts run as <strong>${esc('the panel user')}</strong> on this server with a temporary working directory and a hard timeout.
          Output is captured, not streamed.
        </div></div>
        <div class="grid grid-3 mt-2" style="align-items:start">
          <div class="card" style="grid-column:span 2">
            <div class="card-head">${icon('code')}<h3>Script</h3><div class="spacer"></div>
              <select class="select input-sm" id="py-sample" style="width:auto">
                <option value="">Load example…</option>
                <option value="inspect">Host inspection</option>
                <option value="enumerate">List root directory</option>
                <option value="ports">Local port check</option>
              </select>
            </div>
            <textarea class="textarea" id="py-code" spellcheck="false" style="height:min(52dvh,480px)"
              placeholder="print('hello from the server')"></textarea>
            <div class="row mt-2">
              <div class="field" style="width:130px">
                <label>Timeout</label>
                <select class="select input-sm" id="py-timeout">
                  <option value="10">10 s</option>
                  <option value="30" selected>30 s</option>
                  <option value="60">60 s</option>
                  <option value="120">120 s</option>
                </select>
              </div>
              <div class="spacer"></div>
              <button class="btn btn-soft" id="py-clear">Clear output</button>
              <button class="btn btn-primary" id="py-run">${icon('play', 'icon-sm')} Run script</button>
            </div>
          </div>
          <div class="card">
            <div class="card-head">${icon('terminal')}<h3>Output</h3><div class="spacer"></div>
              <span class="small muted" id="py-meta"></span></div>
            <div class="code-box wrap" id="py-out" style="height:min(52dvh,420px);white-space:pre-wrap">Not run yet.</div>
          </div>
        </div>
      </div>`;

    const code = root.querySelector('#py-code');
    const out = root.querySelector('#py-out');
    const meta = root.querySelector('#py-meta');
    const runBtn = root.querySelector('#py-run');
    const last = sessionStorage.getItem('pt-py-code');
    if (last) code.value = last;
    code.addEventListener('input', () => sessionStorage.setItem('pt-py-code', code.value));

    root.querySelector('#py-sample').addEventListener('change', (e) => {
      const key = e.target.value;
      if (key && SAMPLES[key]) {
        code.value = SAMPLES[key];
        sessionStorage.setItem('pt-py-code', code.value);
      }
      e.target.value = '';
    });

    root.querySelector('#py-clear').addEventListener('click', () => { out.textContent = 'Output cleared.'; meta.textContent = ''; });

    runBtn.addEventListener('click', async () => {
      if (!code.value.trim()) { toast('Write some Python first.', { type: 'warn' }); return; }
      runBtn.disabled = true;
      runBtn.textContent = 'Running…';
      out.textContent = 'Executing…';
      try {
        const res = await api('/api/system/python/run', {
          method: 'POST',
          body: { code: code.value, timeout: Number(root.querySelector('#py-timeout').value) },
        });
        const header = res.timed_out ? 'TIMEOUT' : `exit ${res.exit_code}`;
        out.textContent = `# ${header} · ${res.duration_ms} ms\n${res.stdout || ''}${res.stderr ? `\n--- stderr ---\n${res.stderr}` : ''}` || '(no output)';
        out.style.borderLeft = `3px solid ${res.ok ? 'var(--success)' : 'var(--danger)'}`;
        meta.textContent = `${res.duration_ms} ms`;
      } catch (err) {
        out.textContent = err.message;
        out.style.borderLeft = '3px solid var(--danger)';
        toast(err.message, { type: 'error' });
      } finally {
        runBtn.disabled = false;
        runBtn.innerHTML = `${icon('play', 'icon-sm')} Run script`;
      }
    });

    return () => {};
  },
};
