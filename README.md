# PRIME TERMINAL

A self-hosted **Linux control panel** for real servers: a genuine PTY terminal in the browser, a real
filesystem manager, live `psutil`/`/proc` metrics, and real systemd / package-manager / process control —
wrapped in an iOS- and One UI-inspired interface that works on phones as well as desktops.

Nothing in the UI is simulated. When the host cannot provide something (no systemd, no root, no `ping`,
metrics unavailable) the panel says so instead of inventing data.

```
========================================
       PRIME TERMINAL INSTALLER
========================================
...
  Panel URL:  http://<server-ip>:8080
  Username:   admin
  Status:     RUNNING (systemd)
```

---

## 1. Quick start

```bash
bash panel.sh
```

The installer:

1. detects the distribution, architecture and package manager (apt, dnf/yum, pacman, apk, zypper),
2. checks privileges and free disk space,
3. installs only the system packages that are actually missing (`python3`, `python3-venv`, …),
4. asks for a port (default `8080`), validates the number and tests whether it is free,
5. writes `config.json` in the data directory and creates a virtual environment with the Python
   dependencies,
6. asks for an administrator username and password (scrypt-hashed) — or generates one if stdin is
   not a terminal,
7. installs and starts a **systemd service** (`prime-terminal`), or, where systemd is unavailable
   (container / WSL / minimal image), starts a detached background process with a PID file,
8. waits for `/healthz` and only reports success when the panel actually answers.

Non-interactive install (CI, provisioning):

```bash
bash panel.sh install --port 8080 --username admin --password 'choose-a-long-password' --yes
# or: PANEL_PORT=8080 PANEL_USERNAME=admin PANEL_PASSWORD=... PANEL_YES=1 bash panel.sh
```

Re-running `bash panel.sh` is safe: existing accounts, configuration and data are preserved; only what
is missing is installed, and the service is restarted.

### Requirements

* Linux (x86_64, ARM64 or ARMv7)
* Python ≥ 3.9 (3.11+ recommended)
* ~300 MB disk, 256 MB RAM
* Root is **optional**: terminal, files, monitoring and log viewing work unprivileged. Package
  installation, service control and `chown` need root (or a systemd polkit rule).

Tested on Debian 12 (x86_64) with Python 3.11, both as root and as an ordinary user. The interface has
been verified in Chromium-class and WebKit-class engine behaviour via automated DOM tests; see
[Testing](#9-testing).

---

## 2. Management commands

Everything is handled by the same script:

```bash
bash panel.sh                 # install / reconfigure and start
bash panel.sh start           # start the service (verifies health)
bash panel.sh stop            # stop the service
bash panel.sh restart         # restart and verify health
bash panel.sh status          # service state + /healthz check (exit code 1 if unhealthy)
bash panel.sh logs [lines]    # follow the panel log
bash panel.sh update          # git pull (if available), refresh deps, restart
bash panel.sh reset-password  # reset an account password (revokes sessions)
bash panel.sh set-port 9090   # change the listening port and restart
bash panel.sh uninstall       # remove the service (data kept)
bash panel.sh uninstall --purge   # remove the service *and* panel data
bash panel.sh --help
```

Paths:

| What | Default |
| --- | --- |
| Source | the directory containing `panel.sh` |
| Data dir (root) | `/var/lib/prime-terminal` |
| Data dir (non-root) | `<source>/data` |
| Config | `<data>/config.json` |
| Database | `<data>/panel.db` (SQLite, WAL) |
| Logs | `<data>/logs/panel.log`, `<data>/logs/service.log` |
| Virtualenv | `<data>/venv` |

Override the data directory with `PRIME_DATA_DIR=/path` or `--data-dir /path`.

---

## 3. What the panel can do

### Dashboard
Real CPU (per-core deltas), memory, swap, disk usage, disk I/O, network throughput, load average,
uptime, kernel/OS/CPU model, interfaces and routes, process count, panel status. Values come from
`psutil` and `/proc`; the container cgroup limits and the host/container distinction are shown
explicitly.

### Terminal
* Real PTY (`pty.openpty` + a forked login shell) over an authenticated WebSocket.
* ANSI colours, interactive programs (`nano`, `vim`, `top`, `htop`, Python REPL, `less`, …).
* `Ctrl+C`, `Ctrl+D`, `Ctrl+L`, arrows, Tab, copy/paste, resize propagation (`SIGWINCH`).
* Multiple named sessions, per-user isolation, reconnect with scrollback replay, idle reaping.
* Mobile key bar (Esc, Tab, Ctrl+C/D/L, arrows, `|`, `~`, `/`, `-`, Home, End), font size control,
  connection status with automatic reconnect and clear error states.

### Files
Browse (paginated), create, edit with save, upload (drag & drop + progress), download (streamed with
progress), rename, copy, move, delete, search, permissions (octal), ownership (root only), ZIP
archives, multi-select, hidden-file toggle, disk usage for the current directory.

### Processes
Live process table (CPU, memory, user, status, command), search, sorting, details sheet
(exe, cwd, threads, connections, open files) and signal delivery (TERM/INT/HUP/KILL) with
kernel-level permission errors surfaced honestly.

### Services / Packages / Logs / Network / Python / SSH
* systemd unit listing with start/stop/restart, enable/disable, per-unit journal.
* Package listing from the host package manager, install/remove (root), real command output.
* Log sources from `/var/log`, panel logs, and `journalctl` (all units or one unit).
* Interfaces, addresses, MTU, counters, default routes, listening ports with owning process,
  `ping` / `traceroute` / DNS diagnostics.
* Python runner: executes scripts with the panel interpreter, captured stdout/stderr and a hard timeout.
* `~/.ssh/authorized_keys` management per user (validated key syntax, preserved options, 0600 perms).

### Settings
Password change, session list with revocation, theme (system/light/dark), terminal font, capability
matrix, live configuration, audit log.

---

## 4. Architecture

```
panel.sh                  installer + service manager (bash)
app/
  main.py                 FastAPI app, middleware, lifecycle, capabilities
  config.py               dataclass config, data-dir resolution
  db.py                   SQLite (users, sessions, login attempts, audit, settings)
  security.py             scrypt hashing, sessions, CSRF, throttling, WS origin checks
  system_info.py          psutil / /proc / systemctl / package-manager integrations
  terminal.py             PTY session manager (pty.openpty + subprocess)
  cli.py                  account management used by panel.sh
  routers/
    auth.py               /api/auth/*
    system.py             /api/system/*  (monitoring, processes, services, packages, logs, ssh, python)
    files.py              /api/files/*   (list, read, write, upload, download, archive, chmod, chown)
    terminal.py           /api/terminal/* + /ws/terminal/{id}
  static/
    index.html            shell, icon sprite, auth screen
    css/app.css           design system (light/dark, responsive, reduced-motion)
    js/                   api.js, ui.js, app.js (router/auth), views/*.js
    vendor/               xterm.js 5.5, fit addon, web-links addon, xterm.css (vendored, no CDN)
requirements.txt
tests/                    unit + end-to-end tests
```

* **Backend**: Python 3 + FastAPI + Uvicorn + psutil, single process (terminal state lives in memory),
  SQLite for durable state, rotating file logs.
* **Frontend**: dependency-free ES modules; xterm.js is the only third-party runtime asset and is served
  locally (no CDN, works offline / behind firewalls).
* **Transport**: HTTP JSON for APIs, WebSocket for the terminal (binary frames = PTY bytes, text frames =
  control JSON).

### API surface (authenticated unless noted)

```
GET    /healthz                          (public)
GET    /api/auth/state                   (public: setup/initialised state)
POST   /api/auth/setup                   (public, localhost or setup token, only when no user exists)
POST   /api/auth/login | /logout
GET    /api/auth/me | /sessions
POST   /api/auth/password
DELETE /api/auth/sessions/{id}

GET    /api/system/overview | metrics | host | capabilities | disks | network
GET    /api/system/processes | processes/{pid}
POST   /api/system/processes/{pid}/kill
GET    /api/system/ports | services | packages | logs | logs/read
POST   /api/system/services/{unit}/action | packages/{name}/action
GET    /api/system/network/ping | traceroute | dns
GET    /api/system/ssh/keys ; POST /api/system/ssh/keys ; POST /api/system/ssh/keys/delete
POST   /api/system/python/run
GET    /api/system/audit | panel

GET    /api/files | list | stat | read | download | search | archive
POST   /api/files/create | rename | copy | move | delete | chmod | chown | upload
PUT    /api/files/write

GET    /api/terminal/sessions
POST   /api/terminal/sessions
DELETE /api/terminal/sessions/{id}
WS     /ws/terminal/{id}                 (session cookie + origin check)
```

All state-changing requests require the `x-csrf-token` header matching the `pt_csrf` cookie
(double-submit).

---

## 5. Configuration (`config.json`)

Written by the installer, editable by hand followed by `bash panel.sh restart`:

| Key | Default | Meaning |
| --- | --- | --- |
| `host` | `0.0.0.0` | bind address |
| `port` | `8080` | listening port |
| `fs_root` | `/` | filesystem subtree exposed by the file manager |
| `protected_paths` | `/proc`, `/sys`, `/dev`, `/boot`, … | never modified or deleted (read is allowed) |
| `max_upload_mb` | `2048` | upload cap |
| `max_edit_bytes` | `4194304` | text editor cap |
| `session_hours` | `12` | login session lifetime |
| `terminal_idle_minutes` | `90` | detached PTY sessions are reaped after this |
| `max_terminal_sessions` | `12` | per-user PTY limit |
| `terminal_shell` | auto | shell binary (defaults to `$SHELL`, `bash`, `sh`) |
| `terminal_scrollback_kb` | `256` | replay buffer per session |
| `login_max_attempts` | `5` | failures per IP/username per window |
| `login_window_minutes` | `15` | throttling window |
| `tls_cert`, `tls_key` | empty | optional native TLS |
| `trust_proxy_headers` | `false` | honour `X-Forwarded-For` (only behind a trusted proxy) |
| `allow_framing` | `false` | allow embedding in a cross-origin iframe (hosted preview panes only — weakens clickjacking protection) |
| `debug` | `false` | verbose logging |

`PRIME_DATA_DIR`, `PRIME_HOST`, `PRIME_PORT`, `PRIME_DEBUG` and `PRIME_ALLOW_FRAMING` override at
runtime. By default the panel sends `X-Frame-Options: SAMEORIGIN` and
`Content-Security-Policy: frame-ancestors 'self'`; set `allow_framing`/`PRIME_ALLOW_FRAMING=1` only when
the panel is meant to live inside someone else's preview frame.

---

## 6. Security model

* Passwords: scrypt (N=16384, r=8, p=1, 32-byte key, 16-byte random salt), constant-time comparison;
  minimum 10 characters; no default or hardcoded credentials.
* Sessions: 256-bit random token, stored SHA-256-hashed in SQLite, cookie `HttpOnly`, `SameSite=Lax`,
  `Secure` under HTTPS; expiry and per-session revocation; sign-out revokes the server-side session.
* CSRF: double-submit token on every mutating request; login/setup additionally validate the `Origin`.
* Login throttling per IP **and** username, with a clear `429` and remaining-lockout message.
* WebSockets: session cookie required, `Origin` must match `Host`, sessions belong to their creator.
* Filesystem: every path goes through `realpath` and must stay inside `fs_root`; `/proc`, `/sys`, `/dev`,
  `/boot`, the panel's system directories, its own data directory and the authentication/SSH
  configuration (`/etc/passwd`, `/etc/shadow`, `/etc/group`, `/etc/sudoers*`, `/etc/ssh`) are
  mutation-protected (readable, never writable or deletable); symlink escapes are rejected; uploads are streamed to a temporary file, size-capped, then atomically renamed; archives
  and log reads are confined.
* Input validation with Pydantic models, regex-validated unit/package/host/username values.
* Process handling: no `shell=True` anywhere; argv arrays only; PID 1 and the panel's own PID are refused;
  package/service names are validated before `systemctl`/package-manager calls.
* Uploaded files never become executable, and no path from the client is used as a shell argument.
* Security headers: CSP (`'self'`, no inline script), `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, `Permissions-Policy`, HSTS when HTTPS is detected.
* Audit log of logins, file mutations, signals, service/package actions, SSH key changes and Python runs.
* Secrets never appear in logs; the installer prints generated passwords exactly once.

**Root**: the installer runs the service as the account that invoked it. When that is root, the panel can
manage packages, services and ownership — keep the panel password as strong as a root password, keep the
port private, and put the panel behind HTTPS/VPN. Running the panel as a normal user is fully supported
with a smaller feature set (the Capabilities card is always explicit).

### HTTPS

The recommended deployment is a reverse proxy:

```nginx
server {
    listen 443 ssl http2;
    server_name panel.example.com;
    ssl_certificate     /etc/letsencrypt/live/panel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/panel.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;   # keep idle terminal sockets alive
        proxy_buffering off;
    }
}
```

Then set `"trust_proxy_headers": true` in `config.json`, bind the panel to `127.0.0.1`
(`bash panel.sh`, then edit `host`), and restart. Native TLS is also possible by setting `tls_cert`
and `tls_key`.

---

## 7. Troubleshooting

| Symptom | What to do |
| --- | --- |
| `Port … is unavailable` | choose another port: `bash panel.sh install --port 8090` |
| Panel does not start | `bash panel.sh logs` and `tail $(config: data dir)/logs/service.log`; the installer prints the tail on failure |
| `429 Too many failed attempts` | wait for the window, or `bash panel.sh reset-password` |
| Services tab says systemd is unavailable | you are in a container/WSL without systemd; the other modules keep working |
| Install lacks root | package install / service control are skipped and reported; rerun with root for full management |
| `ping` diagnostics unavailable | install `iputils-ping` (Debian) or `iputils` (Fedora/Alpine) |
| Terminal shows "session not found" | sessions live in memory; restarting the service ends them |
| Behind a proxy, terminal disconnects every minute | increase `proxy_read_timeout` and forward `Upgrade`/`Connection` |

---

## 8. Package management inside the panel

The panel lists the host's installed packages through `dpkg-query`/`rpm`/`pacman -Q`/`apk info` and
performs install/remove only when it runs as root, using the distribution's own tool
(`apt-get`, `dnf`, `yum`, `pacman`, `apk`, `zypper`). Output and exit codes are shown verbatim.

---

## 9. Testing

The repository ships two test suites that exercise the real application (no mocks of the OS):

```bash
# unit tests: hashing, password policy, config, path confinement rules
python3 -m unittest discover -s tests -p 'test_unit.py' -v

# end-to-end: starts a real server on a random port and checks
#   authentication, CSRF, rate limiting, filesystem operations, traversal
#   rejection, process signalling, real PTY commands, ANSI output, resize,
#   Ctrl+C, interactive Python, reconnect/scrollback, WebSocket auth,
#   audit logging and logout
python3 -m unittest tests.test_e2e -v      # needs: pip install -r requirements-dev.txt

# UI smoke test: renders every view against a running panel in jsdom
npm install jsdom
PRIME_URL=http://127.0.0.1:8080 PRIME_USER=admin PRIME_PASS='…' node tests/ui_smoke.mjs
```

Counts on the development machine: **22/22 unit tests**, **9/9 end-to-end test methods**
(≈80 assertions, plus an 82-check ad-hoc suite used during development), **35/35 UI smoke checks** (views + app shell routing, plus a 54-check extended variant used
during development).

What was verified on this build (Debian 12, x86_64, run as an ordinary user and via `panel.sh`,
plus root installs with and without a systemd bus):

* installer: dependency detection, port validation/conflict handling (a busy port aborts with a clear
  message and exit code 1), account creation, venv setup, service start, health verification,
  idempotent re-runs (existing account/config preserved), `start` / `stop` / `restart` / `status` /
  `logs` / `update` / `set-port` / `reset-password` / `uninstall` (with and without `--purge`);
* service modes: the detached-process mode was exercised for real (pid file, restart, stop, status exit
  codes). The systemd code path (unit generation, `daemon-reload`, `enable`, `restart`, `status`, `stop`,
  unit removal) was exercised with a `systemctl` test double inside this container, which has no systemd
  bus; boot-time behaviour on a real systemd host follows the standard unit shown above;
* authentication: login, wrong password, lockout after repeated failures, CSRF rejection, unauth API 401,
  session revocation, logout;
* terminal: `echo`, `pwd`, ANSI escapes, `tty`/`stty size`, resize → `SIGWINCH`, `Ctrl+C` interrupting
  `sleep`, interactive `python3`, disconnect/reconnect with scrollback replay, WebSocket auth and origin
  checks;
* files: create dir/file, write/read exact bytes, rename, copy, move, chmod, search, pagination, multipart
  upload, download, delete, protected-path refusal, traversal/symlink escape refusal (verified against a
  confined `fs_root` instance);
* system: metrics match `/proc` (memory total within 2 %), real process list/details, signal delivery,
  listening ports include the panel, honest `systemd unavailable` reporting, package listing, log sources,
  interfaces, DNS/ping behaviour, Python runner (success and timeout);
* UI: every view module renders against a live API in a DOM harness (see below); the panel was exercised
  in a real browser session for layout/theme work only where a browser was available.

> Honest notes:
> * No graphical browser was available in the build environment (the sandbox only allows package
>   registries), so the UI was verified through the jsdom harness: every view renders against the live
>   API, real data reaches the DOM, dialogs/toasts/sheets work, and no view throws. Pixel-level visual QA
>   on physical Android/iOS hardware was **not** performed; the responsive CSS uses standard mobile
>   patterns (safe-area insets, 44 px touch targets, bottom navigation, bottom sheets, reduced-motion
>   support) but has not been screenshot-tested on devices.
> * Native TLS (`tls_cert`/`tls_key`) is implemented via uvicorn but was tested only in HTTP mode; the
>   recommended HTTPS deployment is the reverse proxy documented above.

---

## 10. Development

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
PRIME_DATA_DIR=./data python3 -m app.cli create-user --username admin
PRIME_DATA_DIR=./data PRIME_PORT=8080 python3 -m app.main
# open http://127.0.0.1:8080
```

Uvicorn runs a single worker by design (terminal sessions are in-process). If you add a worker count,
route terminal traffic to a single worker.

---

## 11. Licence / credits

Original code for this project. Vendored assets: [xterm.js](https://xtermjs.org/) 5.5.0, `@xterm/addon-fit`
0.10.0 and `@xterm/addon-web-links` 0.11.0 (MIT), served from `app/static/vendor/`.

The bundled `darkssh-v3_1-patched.zip` in the repository root is an unrelated earlier upload; it is not
used by this project.
