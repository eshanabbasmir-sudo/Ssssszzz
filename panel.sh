#!/usr/bin/env bash
# =============================================================================
#  PRIME TERMINAL — installer and service manager
#
#    bash panel.sh                install (or re-configure) and start
#    bash panel.sh start|stop|restart|status|logs
#    bash panel.sh update         refresh dependencies and restart
#    bash panel.sh uninstall      remove the service (data kept by default)
#    bash panel.sh reset-password change an account password
#    bash panel.sh set-port N     change the listening port
#
#  Non-interactive install:
#    bash panel.sh install --port 8080 --username admin --password 'secret1234' --yes
#  Environment equivalents: PANEL_PORT, PANEL_USERNAME, PANEL_PASSWORD,
#    PANEL_DATA_DIR, PANEL_BIND, PANEL_YES=1, PANEL_AUTO_PASSWORD=1
# =============================================================================
set -Eeuo pipefail

APP_NAME="PRIME TERMINAL"
SERVICE_NAME="prime-terminal"
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REQUIREMENTS="$APP_DIR/requirements.txt"
MIN_PY_MINOR=9

# Defaults (overridable through flags/env)
PORT_OVERRIDE="${PANEL_PORT:-}"
USERNAME_OVERRIDE="${PANEL_USERNAME:-}"
PASSWORD_OVERRIDE="${PANEL_PASSWORD:-}"
BIND_OVERRIDE="${PANEL_BIND:-}"
ASSUME_YES="${PANEL_YES:-0}"
AUTO_PASSWORD=0
DO_GIT_PULL=0

# Detected state
OS_ID=""; OS_LIKE=""; OS_NAME=""; OS_VERSION=""; ARCH=""; PM=""
PYTHON=""; DATA_DIR=""; VENV=""; PID_FILE=""; SERVICE_LOG=""; PANEL_LOG=""
CONFIG_FILE=""; SERVICE_MODE=""; INSTALLED_USER=""; GENERATED_PASSWORD=""

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'; C_CYAN=$'\033[36m'
else
  C_RESET=""; C_DIM=""; C_BOLD=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_CYAN=""
fi

step()  { printf '\n%s==>%s %s%s%s\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$1" "$C_RESET"; }
info()  { printf '    %s\n' "$1"; }
ok()    { printf '    %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$1"; }
warn()  { printf '    %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$1"; }
fail()  { printf '    %s✗%s %s\n' "$C_RED" "$C_RESET" "$1"; }
die()   { fail "$1"; printf '\n%sInstallation aborted.%s\n' "$C_RED" "$C_RESET"; exit 1; }

banner() {
  printf '%s\n' "${C_CYAN}========================================${C_RESET}"
  printf '%s\n' "${C_BOLD}       PRIME TERMINAL INSTALLER${C_RESET}"
  printf '%s\n' "${C_CYAN}========================================${C_RESET}"
}

on_error() {
  local code=$?
  printf '\n%sUnexpected failure (exit %s) near line %s.%s\n' "$C_RED" "$code" "${BASH_LINENO[0]:-?}" "$C_RESET" >&2
  if [ -n "$SERVICE_LOG" ] && [ -f "$SERVICE_LOG" ]; then
    printf '%sLast service log lines:%s\n' "$C_DIM" "$C_RESET" >&2
    tail -n 20 "$SERVICE_LOG" >&2 || true
  fi
  exit "$code"
}
trap on_error ERR

# ---------------------------------------------------------------------------
# Small utilities
# ---------------------------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif have sudo; then
    if [ -t 0 ]; then sudo "$@"; else sudo -n "$@"; fi
  else
    return 127
  fi
}

confirm() {
  local prompt="$1" default="${2:-n}" reply
  if [ "$ASSUME_YES" = "1" ]; then return 0; fi
  if [ ! -t 0 ]; then
    [ "$default" = "y" ] && return 0 || return 1
  fi
  printf '  %s [%s]: ' "$prompt" "$( [ "$default" = "y" ] && echo Y/n || echo y/N )"
  read -r reply || reply=""
  reply="${reply:-$default}"
  case "$reply" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

ask() {
  # ask <label> <default> <varname>
  local label="$1" default="$2" var="$3" input=""
  if [ ! -t 0 ]; then
    printf -v "$var" '%s' "$default"
    return 0
  fi
  printf '  %s [%s]: ' "$label" "$default"
  read -r input || input=""
  [ -z "$input" ] && input="$default"
  printf -v "$var" '%s' "$input"
}

ask_secret() {
  # ask_secret <label> <varname>
  local label="$1" var="$2" value=""
  if [ ! -t 0 ]; then
    printf -v "$var" '%s' ""
    return 0
  fi
  printf '  %s: ' "$label"
  read -rs value || value=""
  printf '\n'
  printf -v "$var" '%s' "$value"
}

gen_password() {
  "$PYTHON" - <<'PY'
import secrets, string
alphabet = string.ascii_letters + string.digits + "-_.!@#%+="
while True:
    pw = "".join(secrets.choice(alphabet) for _ in range(20))
    if (any(c.islower() for c in pw) and any(c.isupper() for c in pw)
            and any(c.isdigit() for c in pw) and any(c in "-_.!@#%+=" for c in pw)):
        print(pw)
        break
PY
}

primary_ip() {
  "$PYTHON" - <<'PY' 2>/dev/null || echo "127.0.0.1"
import socket

def usable(ip):
    return ip and not ip.startswith("127.") and not ip.startswith("169.254.")

candidates = []
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
try:
    s.settimeout(0.5)
    s.connect(("8.8.8.8", 53))
    candidates.append(s.getsockname()[0])
except OSError:
    pass
finally:
    s.close()
try:
    for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
        candidates.append(info[4][0])
except OSError:
    pass

for ip in candidates:
    if usable(ip):
        print(ip)
        break
else:
    print(candidates[0] if candidates else "127.0.0.1")
PY
}

# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------
detect_os() {
  step "Checking operating system..."
  if [ "$(uname -s)" != "Linux" ]; then
    die "PRIME TERMINAL requires Linux (detected $(uname -s)). The terminal and file manager depend on Linux system interfaces."
  fi
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64|amd64) ARCH_LABEL="x86_64" ;;
    aarch64|arm64) ARCH_LABEL="arm64" ;;
    armv7l|armv6l) ARCH_LABEL="armv7" ;;
    *) ARCH_LABEL="$ARCH" ;;
  esac
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_ID="${ID:-unknown}"
    OS_LIKE="${ID_LIKE:-}"
    OS_NAME="${PRETTY_NAME:-${NAME:-Linux}}"
    OS_VERSION="${VERSION_ID:-}"
  else
    OS_ID="unknown"; OS_LIKE=""; OS_NAME="$(uname -s)"; OS_VERSION=""
  fi

  for candidate in apt-get dnf yum pacman apk zypper; do
    if have "$candidate"; then PM="$candidate"; break; fi
  done
  case "$PM" in
    apt-get) PM_KIND="apt" ;;
    dnf|yum) PM_KIND="$PM" ;;
    pacman) PM_KIND="pacman" ;;
    apk) PM_KIND="apk" ;;
    zypper) PM_KIND="zypper" ;;
    *) PM_KIND="" ;;
  esac

  ok "$OS_NAME ($ARCH_LABEL)"
  if [ -n "$PM" ]; then
    info "Package manager: $PM"
  else
    warn "No supported package manager found — existing Python packages will be used if present."
  fi
  if [ -f /.dockerenv ] || [ -f /run/.containerenv ]; then
    info "Container detected: host-level actions may be restricted."
  fi
}

PY_REPORTED=${PY_REPORTED:-0}
detect_python() {
  [ "$PY_REPORTED" = "1" ] || step "Checking Python runtime..."
  local candidate version
  for candidate in python3 python3.13 python3.12 python3.11 python3.10 python3.9 python; do
    if have "$candidate"; then
      version="$("$candidate" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null || echo 0.0)"
      local major="${version%%.*}" minor="${version#*.}"
      if [ "$major" -eq 3 ] && [ "$minor" -ge "$MIN_PY_MINOR" ]; then
        PYTHON="$(command -v "$candidate")"
        [ "$PY_REPORTED" = "1" ] || ok "Python $version at $PYTHON"
        PY_REPORTED=1
        return 0
      fi
    fi
  done
  warn "Python 3.${MIN_PY_MINOR}+ not found."
  return 1
}

install_system_deps() {
  step "Installing required packages..."
  local need_python=0
  detect_python || need_python=1

  if [ -z "$PM" ]; then
    if [ "$need_python" -eq 1 ]; then
      die "Python 3.${MIN_PY_MINOR}+ is required but no package manager is available to install it."
    fi
    return 0
  fi

  if [ "$(id -u)" -ne 0 ] && ! have sudo; then
    if [ "$need_python" -eq 1 ]; then
      die "Installing packages requires root (or sudo). Re-run with sudo, or install Python 3.${MIN_PY_MINOR}+ manually."
    fi
    warn "Not running as root and sudo is missing: skipping system package installation."
    return 0
  fi

  local missing=()
  [ "$need_python" -eq 1 ] && missing+=("python3")

  case "$PM_KIND" in
    apt)
      missing+=("python3-venv" "python3-pip")
      ;;
    dnf|yum) missing+=("python3-pip") ;;
    *) : ;;
  esac

  # Only touch the package manager when something is actually missing.
  if [ "$need_python" -eq 0 ] && "$PYTHON" -c 'import venv, ensurepip' >/dev/null 2>&1; then
    ok "Python and venv support already present — no package installation needed."
  else
    info "Updating package index…"
    case "$PM_KIND" in
      apt) as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq || warn "apt-get update reported errors; continuing." ;;
      dnf) as_root dnf -q makecache || true ;;
      yum) as_root yum -q makecache || true ;;
      pacman) as_root pacman -Sy --noconfirm >/dev/null 2>&1 || true ;;
      apk) as_root apk update -q || true ;;
      zypper) as_root zypper -q refresh || true ;;
    esac
    info "Installing: ${missing[*]}"
    case "$PM_KIND" in
      apt) as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}" ;;
      dnf) as_root dnf install -y "${missing[@]}" ;;
      yum) as_root yum install -y "${missing[@]}" ;;
      pacman) as_root pacman -S --noconfirm --needed python python-pip ;;
      apk) as_root apk add --no-cache python3 py3-pip ;;
      zypper) as_root zypper --non-interactive install python3 python3-pip ;;
    esac
    detect_python || die "Python installation failed. Install Python 3.${MIN_PY_MINOR}+ and re-run."
    ok "System packages installed."
  fi

  # Optional diagnostic tools (never fatal).
  if ! have ping; then
    info "Installing optional network diagnostics (ping)…"
    case "$PM_KIND" in
      apt) as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends iputils-ping >/dev/null 2>&1 || warn "Could not install iputils-ping (diagnostics will report it)." ;;
      dnf|yum) as_root "$PM" install -y iputils >/dev/null 2>&1 || true ;;
      apk) as_root apk add --no-cache iputils >/dev/null 2>&1 || true ;;
      pacman) as_root pacman -S --noconfirm --needed iputils >/dev/null 2>&1 || true ;;
      *) : ;;
    esac
  fi
}

check_resources() {
  step "Checking permissions and disk space..."
  if [ "$(id -u)" -eq 0 ]; then
    ok "Running as root — package, service and ownership management will be available."
    info "The panel service will run as root, so treat the panel password like a root password."
  else
    warn "Running as $(id -un) (not root)."
    info "Terminal, files and monitoring work; package install, service control and chown need root."
  fi
  mkdir -p "$DATA_DIR" 2>/dev/null || die "Cannot create data directory $DATA_DIR"
  local avail_kb
  avail_kb="$(df -Pk "$DATA_DIR" | awk 'NR==2 {print $4}')"
  if [ -n "$avail_kb" ] && [ "$avail_kb" -lt 300000 ]; then
    die "Not enough free disk space in $DATA_DIR (need ~300 MB, have $((avail_kb/1024)) MB)."
  fi
  ok "Writable data directory: $DATA_DIR ($(( ${avail_kb:-0} / 1024 )) MB free)"
}

# ---------------------------------------------------------------------------
# Data directory resolution (works for every sub-command)
# ---------------------------------------------------------------------------
resolve_paths() {
  if [ -n "${PRIME_DATA_DIR:-}" ]; then
    DATA_DIR="$PRIME_DATA_DIR"
  elif [ -f "/var/lib/$SERVICE_NAME/config.json" ]; then
    DATA_DIR="/var/lib/$SERVICE_NAME"
  elif [ -f "$APP_DIR/data/config.json" ]; then
    DATA_DIR="$APP_DIR/data"
  elif [ "$(id -u)" -eq 0 ]; then
    DATA_DIR="/var/lib/$SERVICE_NAME"
  else
    DATA_DIR="$APP_DIR/data"
  fi
  VENV="$DATA_DIR/venv"
  if [ -z "${PYTHON:-}" ]; then
    PYTHON="$(command -v python3 || true)"
  fi
  PID_FILE="$DATA_DIR/panel.pid"
  SERVICE_LOG="$DATA_DIR/logs/service.log"
  PANEL_LOG="$DATA_DIR/logs/panel.log"
  CONFIG_FILE="$DATA_DIR/config.json"
}

# ---------------------------------------------------------------------------
# Configuration helpers
# ---------------------------------------------------------------------------
config_get() {
  # config_get <key> <default>
  local key="$1" default="${2:-}"
  if [ -f "$CONFIG_FILE" ]; then
    "$PYTHON" - "$CONFIG_FILE" "$key" "$default" <<'PY'
import json, sys
path, key, default = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    data = json.load(open(path))
except Exception:
    print(default); raise SystemExit
value = data.get(key, default)
if isinstance(value, bool):
    print("true" if value else "false")
elif value is None:
    print(default)
else:
    print(value)
PY
  else
    printf '%s\n' "$default"
  fi
}

config_set() {
  # config_set key=value [key=value ...]
  mkdir -p "$DATA_DIR"
  "$PYTHON" - "$CONFIG_FILE" "$@" <<'PY'
import json, os, sys, tempfile
path = sys.argv[1]
data = {}
if os.path.exists(path):
    try:
        data = json.load(open(path))
    except Exception:
        data = {}
for pair in sys.argv[2:]:
    key, _, value = pair.partition("=")
    if value.lower() in ("true", "false"):
        data[key] = value.lower() == "true"
    elif value.isdigit():
        data[key] = int(value)
    else:
        data[key] = value
os.makedirs(os.path.dirname(path), exist_ok=True)
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
with os.fdopen(fd, "w") as fh:
    json.dump(data, fh, indent=2)
    fh.write("\n")
os.replace(tmp, path)
os.chmod(path, 0o600)
PY
}

port_available() {
  # port_available <port> <bind-address>
  "$PYTHON" - "$1" "$2" <<'PY'
import socket, sys
port = int(sys.argv[1]); host = sys.argv[2]
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    s.bind((host, port))
except OSError:
    print("busy")
    raise SystemExit(1)
finally:
    s.close()
print("free")
PY
}

panel_healthy() {
  # panel_healthy <port>
  "$PYTHON" - "$1" <<'PY' 2>/dev/null
import sys, urllib.request
port = sys.argv[1]
try:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=2) as r:
        body = r.read(200)
        if b'"prime-terminal"' in body:
            print("ok"); raise SystemExit(0)
except Exception:
    pass
raise SystemExit(1)
PY
}

# ---------------------------------------------------------------------------
# Port selection
# ---------------------------------------------------------------------------
choose_port() {
  step "Selecting the panel port"
  local current_port default_port port
  current_port="$(config_get port 8080)"
  default_port="${PORT_OVERRIDE:-${current_port:-8080}}"
  local attempts=0
  while true; do
    attempts=$((attempts + 1))
    [ "$attempts" -gt 8 ] && die "Too many invalid port attempts."
    if [ -n "$PORT_OVERRIDE" ] && [ "$attempts" -eq 1 ]; then
      port="$PORT_OVERRIDE"
    elif [ ! -t 0 ]; then
      port="$default_port"
    else
      ask "Enter panel port" "$default_port" port
    fi
    if ! [[ "$port" =~ ^[0-9]+$ ]] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
      warn "Port must be a number between 1 and 65535."
      PORT_OVERRIDE=""
      continue
    fi
    if [ "$port" -lt 1024 ] && [ "$(id -u)" -ne 0 ]; then
      warn "Ports below 1024 require root. Choose a higher port."
      PORT_OVERRIDE=""
      continue
    fi
    local status
    if status="$(port_available "$port" "$( [ -n "$BIND_OVERRIDE" ] && echo "$BIND_OVERRIDE" || echo 0.0.0.0 )")"; then
      ok "Port $port is available."
      PANEL_PORT="$port"
      return 0
    else
      # Is the port already used by this very panel?
      if panel_healthy "$port" >/dev/null 2>&1; then
        ok "An existing PRIME TERMINAL instance already answers on port $port — reusing it."
        PANEL_PORT="$port"
        return 0
      fi
      warn "Port $port is already in use by another service."
      if [ "$ASSUME_YES" = "1" ] || [ ! -t 0 ]; then
        die "Port $port is unavailable. Re-run with --port <free-port>."
      fi
      PORT_OVERRIDE=""
      default_port=$((port + 1))
    fi
  done
}

# ---------------------------------------------------------------------------
# Python environment
# ---------------------------------------------------------------------------
setup_venv() {
  step "Installing application dependencies"
  if [ ! -d "$VENV" ]; then
    info "Creating virtual environment in $VENV"
    if ! "$PYTHON" -m venv "$VENV" >/dev/null 2>&1; then
      warn "venv creation failed — trying to install python3-venv."
      case "$PM_KIND" in
        apt) as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3-venv python3-pip ;;
        dnf|yum) as_root "$PM" install -y python3-pip ;;
        apk) as_root apk add --no-cache python3 py3-pip ;;
        pacman) as_root pacman -S --noconfirm --needed python-pip ;;
        zypper) as_root zypper --non-interactive install python3-pip ;;
        *) die "Cannot create a virtual environment: the 'venv' module is unavailable." ;;
      esac
      "$PYTHON" -m venv "$VENV" || die "Failed to create virtual environment."
    fi
    ok "Virtual environment created."
  else
    ok "Existing virtual environment found."
  fi

  local req_hash current_hash
  req_hash="$("$PYTHON" -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$REQUIREMENTS")"
  current_hash="$(cat "$DATA_DIR/requirements.sha256" 2>/dev/null || echo none)"

  if [ "$req_hash" = "$current_hash" ] && "$VENV/bin/python" -c 'import fastapi, uvicorn, psutil, multipart' >/dev/null 2>&1; then
    ok "Python dependencies already satisfied."
    return 0
  fi

  info "Installing Python packages (this can take a minute)…"
  export PIP_DISABLE_PIP_VERSION_CHECK=1
  if ! "$VENV/bin/python" -m pip install --quiet --upgrade pip >/dev/null 2>&1; then
    warn "Could not upgrade pip; using the bundled version."
  fi
  if ! "$VENV/bin/python" -m pip install --quiet -r "$REQUIREMENTS"; then
    warn "pip install failed. Retrying after installing build tooling…"
    case "$PM_KIND" in
      apt) as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends build-essential python3-dev python3-venv >/dev/null 2>&1 || true ;;
      dnf|yum) as_root "$PM" install -y gcc python3-devel >/dev/null 2>&1 || true ;;
      apk) as_root apk add --no-cache build-base python3-dev linux-headers >/dev/null 2>&1 || true ;;
      pacman) as_root pacman -S --noconfirm --needed base-devel >/dev/null 2>&1 || true ;;
      zypper) as_root zypper --non-interactive install gcc python3-devel >/dev/null 2>&1 || true ;;
      *) : ;;
    esac
    "$VENV/bin/python" -m pip install -r "$REQUIREMENTS" || die "Python dependency installation failed. Check network access and re-run."
  fi
  printf '%s\n' "$req_hash" > "$DATA_DIR/requirements.sha256"
  ok "Python dependencies installed."
}

# ---------------------------------------------------------------------------
# Accounts
# ---------------------------------------------------------------------------
setup_account() {
  step "Configuring secure access"
  local users
  users="$( cd "$APP_DIR" && PRIME_DATA_DIR="$DATA_DIR" "$VENV/bin/python" -m app.cli list-users 2>/dev/null || true)"
  if [ -n "$users" ] && [ "$users" != "no users configured" ]; then
    INSTALLED_USER="$(printf '%s' "$users" | head -n1 | "$VENV/bin/python" -c 'import json,sys; print(json.loads(sys.stdin.readline())["username"])' 2>/dev/null || echo "existing")"
    ok "Existing panel account detected ($INSTALLED_USER) — credentials left unchanged."
    info "Use 'bash panel.sh reset-password' if you forgot the password."
    return 0
  fi

  local username password confirm_password
  if [ -n "$USERNAME_OVERRIDE" ]; then
    username="$USERNAME_OVERRIDE"
  elif [ -t 0 ]; then
    ask "Admin username" "admin" username
  else
    username="admin"
  fi

  if [ -n "$PASSWORD_OVERRIDE" ]; then
    password="$PASSWORD_OVERRIDE"
  elif [ "$AUTO_PASSWORD" = "1" ] || [ ! -t 0 ]; then
    password="$(gen_password)"
    GENERATED_PASSWORD="$password"
  else
    while true; do
      ask_secret "Password (min 10 characters, hidden)" password
      if [ "${#password}" -lt 10 ]; then
        warn "Password must be at least 10 characters."
        continue
      fi
      ask_secret "Repeat password" confirm_password
      if [ "$password" != "$confirm_password" ]; then
        warn "Passwords do not match."
        continue
      fi
      break
    done
  fi

  if [ "${#password}" -lt 10 ]; then
    die "Password must be at least 10 characters."
  fi

  if ! ( cd "$APP_DIR" && printf '%s\n' "$password" | PRIME_DATA_DIR="$DATA_DIR" "$VENV/bin/python" -m app.cli create-user --username "$username" --password-stdin ); then
    die "Could not create the administrator account."
  fi
  INSTALLED_USER="$username"
  ok "Administrator account '$username' created (scrypt-hashed)."
}

# ---------------------------------------------------------------------------
# Service management
# ---------------------------------------------------------------------------
systemd_usable() {
  [ -d /run/systemd/system ] || return 1
  have systemctl || return 1
  systemctl is-system-running >/dev/null 2>&1 || systemctl --version >/dev/null 2>&1
  # is-system-running exits non-zero for "degraded" but the bus is reachable.
  systemctl list-units --type=service --no-legend --no-pager >/dev/null 2>&1
}

unit_path() { echo "/etc/systemd/system/${SERVICE_NAME}.service"; }

run_user() {
  if [ "$(id -u)" -eq 0 ]; then echo "root"; else id -un; fi
}

write_unit() {
  local unit; unit="$(unit_path)"
  local user; user="$(run_user)"
  local tmp; tmp="$(mktemp)"
  cat > "$tmp" <<EOF
[Unit]
Description=PRIME TERMINAL — Linux control panel
Documentation=file:$APP_DIR/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$user
WorkingDirectory=$APP_DIR
Environment=PRIME_DATA_DIR=$DATA_DIR
Environment=PYTHONUNBUFFERED=1
ExecStart=$VENV/bin/python -m app.main
Restart=on-failure
RestartSec=3
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=15
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
  as_root install -m 0644 "$tmp" "$unit"
  rm -f "$tmp"
  as_root systemctl daemon-reload
}

nohup_start() {
  mkdir -p "$DATA_DIR/logs"
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    return 0
  fi
  cd "$APP_DIR"
  if have setsid; then
    PRIME_DATA_DIR="$DATA_DIR" setsid nohup "$VENV/bin/python" -m app.main >>"$SERVICE_LOG" 2>&1 < /dev/null &
  else
    PRIME_DATA_DIR="$DATA_DIR" nohup "$VENV/bin/python" -m app.main >>"$SERVICE_LOG" 2>&1 < /dev/null &
  fi
  echo $! > "$PID_FILE"
  cd - >/dev/null
}

nohup_stop() {
  if [ ! -f "$PID_FILE" ]; then
    return 0
  fi
  local pid; pid="$(cat "$PID_FILE")"
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
}

install_service() {
  step "Configuring the background service"
  if [ "$(id -u)" -eq 0 ] && systemd_usable; then
    SERVICE_MODE="systemd"
    write_unit
    as_root systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || warn "Could not enable the unit at boot."
    ok "systemd unit installed: $(unit_path)"
    info "The panel will start automatically on boot."
  else
    SERVICE_MODE="nohup"
    ok "No usable systemd — the panel runs as a detached background process."
    if [ "$(id -u)" -ne 0 ]; then
      info "Run 'bash panel.sh start' after a reboot (or add it to your init system)."
    else
      warn "systemd is not available in this environment; boot persistence is not configured."
    fi
  fi
}

start_service() {
  step "Starting the terminal service"
  if [ "$SERVICE_MODE" = "systemd" ]; then
    as_root systemctl restart "$SERVICE_NAME" || {
      fail "systemctl could not start the service."
      as_root systemctl status "$SERVICE_NAME" --no-pager -l | tail -n 20 || true
      return 1
    }
  else
    nohup_stop
    nohup_start
  fi

  local port; port="$(config_get port 8080)"
  local i
  for i in $(seq 1 60); do
    if panel_healthy "$port" >/dev/null 2>&1; then
      ok "Panel answered its health check on port $port."
      return 0
    fi
    sleep 0.5
  done

  fail "The panel did not respond on port $port within 30 seconds."
  if [ -f "$SERVICE_LOG" ]; then
    printf '\n%s--- service log ---%s\n' "$C_DIM" "$C_RESET"
    tail -n 30 "$SERVICE_LOG" || true
  fi
  printf '\n%s--- panel log ---%s\n' "$C_DIM" "$C_RESET"
  tail -n 30 "$PANEL_LOG" 2>/dev/null || true
  return 1
}

stop_service() {
  if [ "$SERVICE_MODE" = "systemd" ]; then
    as_root systemctl stop "$SERVICE_NAME" || return 1
  else
    nohup_stop
  fi
}

service_active() {
  if [ "$SERVICE_MODE" = "systemd" ]; then
    as_root systemctl is-active --quiet "$SERVICE_NAME"
  else
    [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
  fi
}

# ---------------------------------------------------------------------------
# Install flow
# ---------------------------------------------------------------------------
print_summary() {
  local port ip scheme="http"
  port="$(config_get port 8080)"
  ip="$(primary_ip)"
  [ "$(config_get tls_cert '')" != "" ] && scheme="https"

  printf '\n%s\n' "${C_GREEN}========================================${C_RESET}"
  printf '%s\n' "${C_BOLD}${C_GREEN}       INSTALLATION COMPLETE${C_RESET}"
  printf '%s\n' "${C_GREEN}========================================${C_RESET}"
  printf '\n  %sPanel URL:%s  %s://%s:%s\n' "$C_BOLD" "$C_RESET" "$scheme" "$ip" "$port"
  printf '  %sLocal URL:%s  %s://127.0.0.1:%s\n' "$C_BOLD" "$C_RESET" "$scheme" "$port"
  printf '  %sUsername:%s   %s\n' "$C_BOLD" "$C_RESET" "${INSTALLED_USER:-existing account}"
  if [ -n "$GENERATED_PASSWORD" ]; then
    printf '  %sPassword:%s   %s%s%s  %s(shown once — store it now)%s\n' "$C_BOLD" "$C_RESET" "$C_YELLOW" "$GENERATED_PASSWORD" "$C_RESET" "$C_DIM" "$C_RESET"
  fi
  printf '  %sStatus:%s     %sRUNNING%s (%s)\n' "$C_BOLD" "$C_RESET" "$C_GREEN" "$C_RESET" "$SERVICE_MODE"
  printf '  %sData:%s       %s\n' "$C_BOLD" "$C_RESET" "$DATA_DIR"
  printf '  %sSource:%s     %s\n' "$C_BOLD" "$C_RESET" "$APP_DIR"
  printf '\n  %sManagement commands%s\n' "$C_BOLD" "$C_RESET"
  printf '    bash panel.sh status      show service state and health\n'
  printf '    bash panel.sh restart     restart the panel\n'
  printf '    bash panel.sh logs        follow the service log\n'
  printf '    bash panel.sh update      refresh dependencies, restart\n'
  printf '    bash panel.sh reset-password\n'
  printf '    bash panel.sh uninstall\n'
  printf '\n  %sSecurity note:%s the panel has the privileges of the %s account.\n' "$C_YELLOW" "$C_RESET" "$(run_user)"
  printf '  Put it behind HTTPS (Caddy/nginx) before exposing it to the internet.\n\n'
  printf '  Use Ctrl+C only if running in the foreground.\n'
}

do_install() {
  banner
  resolve_paths
  detect_os
  check_resources
  install_system_deps
  detect_python || die "Python 3.${MIN_PY_MINOR}+ is required."

  choose_port
  local bind="${BIND_OVERRIDE:-$(config_get host 0.0.0.0)}"
  step "Writing configuration"
  mkdir -p "$DATA_DIR/logs"
  chmod 700 "$DATA_DIR" 2>/dev/null || true
  config_set "host=$bind" "port=$PANEL_PORT" "panel_name=PRIME TERMINAL"
  ok "Configuration written to $CONFIG_FILE"

  setup_venv
  setup_account
  install_service
  start_service || die "The panel failed to start. Check the logs above; the service is not running."

  print_summary
}

do_start() {
  resolve_paths
  [ -d "$VENV" ] || die "Panel is not installed here (no virtual environment at $VENV). Run: bash panel.sh"
  detect_python || die "Python runtime missing."
  if [ -f "$(unit_path)" ] && [ "$(id -u)" -eq 0 ] && systemd_usable; then
    SERVICE_MODE="systemd"
  else
    SERVICE_MODE="nohup"
    nohup_stop
  fi
  [ "$SERVICE_MODE" = "systemd" ] && as_root systemctl start "$SERVICE_NAME"
  [ "$SERVICE_MODE" = "nohup" ] && nohup_start
  # Verify honestly.
  local port; port="$(config_get port 8080)"
  for _ in $(seq 1 40); do
    if panel_healthy "$port" >/dev/null 2>&1; then ok "PRIME TERMINAL is running on port $port."; return 0; fi
    sleep 0.5
  done
  fail "PRIME TERMINAL did not become healthy on port $port."
  tail -n 20 "$SERVICE_LOG" 2>/dev/null || true
  return 1
}

do_stop() {
  resolve_paths
  detect_python >/dev/null 2>&1 || true
  if [ -f "$(unit_path)" ] && [ "$(id -u)" -eq 0 ] && systemd_usable; then
    SERVICE_MODE="systemd"
  else
    SERVICE_MODE="nohup"
  fi
  stop_service || warn "The service was not running."
  ok "PRIME TERMINAL stopped."
}

do_restart() {
  resolve_paths
  detect_python >/dev/null 2>&1 || true
  if [ -f "$(unit_path)" ] && [ "$(id -u)" -eq 0 ] && systemd_usable; then
    SERVICE_MODE="systemd"
    as_root systemctl restart "$SERVICE_NAME" || die "Restart failed."
  else
    SERVICE_MODE="nohup"
    nohup_stop
    nohup_start
  fi
  local port; port="$(config_get port 8080)"
  for _ in $(seq 1 40); do
    if panel_healthy "$port" >/dev/null 2>&1; then ok "PRIME TERMINAL restarted on port $port."; return 0; fi
    sleep 0.5
  done
  fail "Restarted process is not answering on port $port."
  tail -n 20 "$SERVICE_LOG" 2>/dev/null || true
  return 1
}

do_status() {
  resolve_paths
  detect_python >/dev/null 2>&1 || true
  local port; port="$(config_get port 8080)"
  printf '%sPRIME TERMINAL status%s\n\n' "$C_BOLD" "$C_RESET"
  printf '  Data directory : %s\n' "$DATA_DIR"
  printf '  Port           : %s\n' "$port"
  if [ -f "$(unit_path)" ] && systemd_usable; then
    printf '  Service        : systemd unit %s\n' "$SERVICE_NAME"
    systemctl status "$SERVICE_NAME" --no-pager -l 2>/dev/null | sed 's/^/  /' | head -n 12 || true
  else
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      printf '  Service        : background process (pid %s)\n' "$(cat "$PID_FILE")"
    else
      printf '  Service        : not running\n'
    fi
  fi
  if [ -n "$PYTHON" ] || [ -x "$VENV/bin/python" ]; then
    if panel_healthy "$port" >/dev/null 2>&1; then
      printf '  Health         : %sOK%s (http://127.0.0.1:%s/healthz)\n' "$C_GREEN" "$C_RESET" "$port"
      printf '  Reachable at   : http://%s:%s\n' "$(primary_ip)" "$port"
      exit 0
    else
      printf '  Health         : %sFAILED%s — no healthy response on port %s\n' "$C_RED" "$C_RESET" "$port"
      [ -f "$PANEL_LOG" ] && tail -n 5 "$PANEL_LOG" | sed 's/^/    /'
      exit 1
    fi
  else
    printf '  Health         : unknown (Python not found)\n'
    exit 1
  fi
}

do_logs() {
  resolve_paths
  local lines="${1:-60}"
  [ -f "$PANEL_LOG" ] || die "No panel log at $PANEL_LOG (is the panel installed?)"
  info "Following $PANEL_LOG (Ctrl+C to stop)…"
  tail -n "$lines" -f "$PANEL_LOG"
}

do_update() {
  resolve_paths
  banner
  detect_os
  detect_python || die "Python runtime missing."
  if [ -d "$APP_DIR/.git" ] && have git; then
    info "Checking for source updates…"
    if git -C "$APP_DIR" pull --ff-only >/dev/null 2>&1; then
      ok "Source updated from git."
    else
      warn "git pull skipped (no upstream, local changes, or not a repository)."
    fi
  fi
  setup_venv
  setup_account
  if [ "$(id -u)" -eq 0 ] && systemd_usable; then
    SERVICE_MODE="systemd"
    write_unit
  else
    SERVICE_MODE="nohup"
  fi
  do_restart
  ok "Update complete."
}

do_reset_password() {
  resolve_paths
  detect_python || die "Python runtime missing."
  [ -d "$VENV" ] || die "Panel is not installed (no venv at $VENV)."
  local username="${1:-}"
  if [ -z "$username" ]; then
    if [ -t 0 ]; then ask "Username" "admin" username; else username="admin"; fi
  fi
  local password confirm_password
  if [ -t 0 ]; then
    while true; do
      ask_secret "New password (min 10 characters)" password
      [ "${#password}" -lt 10 ] && { warn "Too short."; continue; }
      ask_secret "Repeat password" confirm_password
      [ "$password" != "$confirm_password" ] && { warn "Passwords do not match."; continue; }
      break
    done
  else
    password="$(gen_password)"
    GENERATED_PASSWORD="$password"
  fi
  if ! ( cd "$APP_DIR" && printf '%s\n' "$password" | PRIME_DATA_DIR="$DATA_DIR" "$VENV/bin/python" -m app.cli reset-password --username "$username" --password-stdin ); then
    die "Password reset failed."
  fi
  ok "Password updated for '$username'. All existing sessions were revoked."
  [ -n "$GENERATED_PASSWORD" ] && info "New password: $GENERATED_PASSWORD"
  return 0
}

do_set_port() {
  resolve_paths
  detect_python || die "Python runtime missing."
  local new_port="${1:-}"
  [ -z "$new_port" ] && die "Usage: bash panel.sh set-port <port>"
  if ! [[ "$new_port" =~ ^[0-9]+$ ]] || [ "$new_port" -lt 1 ] || [ "$new_port" -gt 65535 ]; then
    die "Port must be between 1 and 65535."
  fi
  if ! port_available "$new_port" "$(config_get host 0.0.0.0)" >/dev/null; then
    die "Port $new_port is already in use."
  fi
  config_set "port=$new_port"
  ok "Port set to $new_port in $CONFIG_FILE"
  if [ -d "$VENV" ]; then
    SERVICE_MODE="nohup"
    [ -f "$(unit_path)" ] && [ "$(id -u)" -eq 0 ] && systemd_usable && SERVICE_MODE="systemd"
    do_restart || warn "Restart failed — run 'bash panel.sh logs' to inspect."
  fi
  info "Open http://$(primary_ip):$new_port"
}

do_uninstall() {
  resolve_paths
  banner
  info "This removes the PRIME TERMINAL service."
  if ! confirm "Remove the service now?" "n"; then
    info "Cancelled."; exit 0
  fi
  detect_python >/dev/null 2>&1 || true
  if [ -f "$(unit_path)" ]; then
    as_root systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
    as_root systemctl disable "$SERVICE_NAME" >/dev/null 2>&1 || true
    as_root rm -f "$(unit_path)"
    as_root systemctl daemon-reload || true
    ok "Systemd unit removed."
  else
    SERVICE_MODE="nohup"
    nohup_stop
    ok "Background process stopped."
  fi
  local purge="${PANEL_PURGE:-0}"
  if [ "$purge" != "1" ] && [ "$ASSUME_YES" != "1" ] && [ -t 0 ]; then
    if confirm "Also delete panel data (accounts, config, logs) in $DATA_DIR?" "n"; then
      purge=1
    fi
  fi
  if [ "$purge" = "1" ]; then
    rm -rf "$DATA_DIR"
    ok "Data directory removed."
  else
    info "Data kept at $DATA_DIR — re-running the installer will reuse it."
    info "Remove it with: bash panel.sh uninstall --purge"
  fi
  info "The source directory $APP_DIR was left untouched; remove it manually if desired."
}

usage() {
  cat <<EOF
PRIME TERMINAL — installer and service manager

  bash panel.sh                       install (or re-configure) and start
  bash panel.sh install [options]     same, with options
  bash panel.sh start                 start the panel
  bash panel.sh stop                  stop the panel
  bash panel.sh restart               restart the panel
  bash panel.sh status                show state and run a health check
  bash panel.sh logs [lines]          follow the panel log
  bash panel.sh update                refresh dependencies and restart
  bash panel.sh reset-password [user] reset an account password
  bash panel.sh set-port <port>       change the listening port
  bash panel.sh uninstall [--purge]   remove the service (--purge deletes data)

Install options:
  --port N            listening port (default 8080, or the current config)
  --username NAME     administrator username (default admin)
  --password PASS     administrator password (default: prompt / generated)
  --bind ADDRESS      bind address (default 0.0.0.0)
  --auto-password     generate a strong password and print it once
  --yes               never prompt (use defaults/options)
  --data-dir PATH     override the data directory
  --purge             (uninstall) also delete accounts, config and logs

Environment: PANEL_PORT, PANEL_USERNAME, PANEL_PASSWORD, PANEL_BIND,
             PANEL_DATA_DIR, PANEL_YES, PANEL_AUTO_PASSWORD
EOF
}

parse_install_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --port) PORT_OVERRIDE="${2:-}"; shift 2 ;;
      --port=*) PORT_OVERRIDE="${1#*=}"; shift ;;
      --username) USERNAME_OVERRIDE="${2:-}"; shift 2 ;;
      --username=*) USERNAME_OVERRIDE="${1#*=}"; shift ;;
      --password) PASSWORD_OVERRIDE="${2:-}"; shift 2 ;;
      --password=*) PASSWORD_OVERRIDE="${1#*=}"; shift ;;
      --bind) BIND_OVERRIDE="${2:-}"; shift 2 ;;
      --data-dir) export PRIME_DATA_DIR="${2:-}"; shift 2 ;;
      --auto-password) AUTO_PASSWORD=1; shift ;;
      --yes|-y) ASSUME_YES=1; shift ;;
      --purge) export PANEL_PURGE=1; shift ;;
      --help|-h) usage; exit 0 ;;
      *) die "Unknown option: $1 (see: bash panel.sh --help)" ;;
    esac
  done
}

main() {
  local command="${1:-install}"
  case "$command" in
    install) shift || true; parse_install_args "$@"; do_install ;;
    start) do_start ;;
    stop) do_stop ;;
    restart) do_restart ;;
    status) do_status ;;
    logs) do_logs "${2:-60}" ;;
    update) do_update ;;
    reset-password|passwd) do_reset_password "${2:-}" ;;
    set-port) do_set_port "${2:-}" ;;
    uninstall|remove) shift || true; parse_install_args "$@"; do_uninstall ;;
    --help|-h|help) usage ;;
    --*) parse_install_args "$@"; do_install ;;
    *) usage; exit 2 ;;
  esac
}

main "$@"
