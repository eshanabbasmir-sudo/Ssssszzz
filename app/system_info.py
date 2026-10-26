"""Real operating-system introspection.

Everything here reads the actual host/container through psutil, /proc and
system utilities.  When something cannot be measured the API reports
``available: false`` with a reason instead of inventing numbers.
"""

from __future__ import annotations

import os
import platform
import re
import shutil
import socket
import subprocess
import time
from pathlib import Path
from typing import Any

import psutil

from .config import Config

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def _read(path: str, default: str = "") -> str:
    try:
        return Path(path).read_text("utf-8", errors="replace").strip()
    except (OSError, ValueError):
        return default


def _run(cmd: list[str], timeout: float = 8.0) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            env={**os.environ, "LC_ALL": "C", "LANG": "C"},
        )
        out = (proc.stdout or "") + (proc.stderr or "")
        return proc.returncode, out.strip()
    except FileNotFoundError:
        return 127, f"{cmd[0]}: command not found"
    except subprocess.TimeoutExpired:
        return 124, f"{cmd[0]}: timed out after {timeout:.0f}s"
    except OSError as exc:
        return 1, f"{cmd[0]}: {exc}"


def is_root() -> bool:
    try:
        return os.geteuid() == 0
    except AttributeError:  # pragma: no cover - non-POSIX
        return False


# --------------------------------------------------------------------------
# Container awareness
# --------------------------------------------------------------------------
def container_info() -> dict[str, Any]:
    kind = None
    if Path("/.dockerenv").exists():
        kind = "docker"
    elif Path("/run/.containerenv").exists():
        kind = "podman"
    elif Path("/proc/1/cgroup").exists():
        cgroup = _read("/proc/1/cgroup")
        if "docker" in cgroup:
            kind = "docker"
        elif "lxc" in cgroup:
            kind = "lxc"
        elif "kubepods" in cgroup:
            kind = "kubernetes"
        elif "systemd-nspawn" in cgroup:
            kind = "systemd-nspawn"
    env = _read("/proc/1/environ").replace("\x00", "\n")
    if kind is None and "container=" in env:
        match = re.search(r"container=([a-z0-9-]+)", env)
        if match:
            kind = match.group(1)

    limits: dict[str, Any] = {"memory_bytes": None, "cpu_cores": None, "cgroup_version": None}
    # cgroup v2
    if Path("/sys/fs/cgroup/cgroup.controllers").exists():
        limits["cgroup_version"] = 2
        raw = _read("/sys/fs/cgroup/memory.max")
        if raw and raw.isdigit():
            limits["memory_bytes"] = int(raw)
        cpu_max = _read("/sys/fs/cgroup/cpu.max").split()
        if len(cpu_max) == 2 and cpu_max[0] not in {"max", ""}:
            try:
                limits["cpu_cores"] = round(int(cpu_max[0]) / int(cpu_max[1]), 2)
            except (ValueError, ZeroDivisionError):
                pass
    # cgroup v1
    elif Path("/sys/fs/cgroup/memory/memory.limit_in_bytes").exists():
        limits["cgroup_version"] = 1
        raw = _read("/sys/fs/cgroup/memory/memory.limit_in_bytes")
        if raw.isdigit():
            limits["memory_bytes"] = int(raw)
        quota = _read("/sys/fs/cgroup/cpu/cpu.cfs_quota_us")
        period = _read("/sys/fs/cgroup/cpu/cpu.cfs_period_us")
        if quota.lstrip("-").isdigit() and period.isdigit() and int(quota) > 0:
            limits["cpu_cores"] = round(int(quota) / int(period), 2)

    unlimited_marker = 2**60
    if limits["memory_bytes"] and limits["memory_bytes"] >= unlimited_marker:
        limits["memory_bytes"] = None
    limits["kind"] = kind
    limits["inside_container"] = bool(kind) or limits["cgroup_version"] is not None and (
        limits["memory_bytes"] is not None or limits["cpu_cores"] is not None
    )
    return limits


def is_systemd_available() -> tuple[bool, str]:
    if not Path("/run/systemd/system").exists():
        if Path("/proc/1/comm").exists() and _read("/proc/1/comm") == "systemd":
            pass
        else:
            return False, "systemd is not running in this environment (container or another init system)."
    if shutil.which("systemctl") is None:
        return False, "systemctl is not installed."
    rc, out = _run(["systemctl", "is-system-running"], timeout=5)
    low = out.lower()
    if rc != 0 and any(word in low for word in ("not booted", "failed to connect to bus", "no such file")):
        return False, "systemctl cannot reach the systemd bus in this environment."
    return True, out or "systemd available"


# --------------------------------------------------------------------------
# Static host information
# --------------------------------------------------------------------------
def _os_release() -> dict[str, str]:
    data: dict[str, str] = {}
    for line in _read("/etc/os-release").splitlines():
        if "=" in line:
            key, _, value = line.partition("=")
            data[key] = value.strip().strip('"')
    return data


def _cpu_model() -> str:
    for line in _read("/proc/cpuinfo").splitlines():
        if line.lower().startswith("model name"):
            return line.split(":", 1)[1].strip()
        if line.lower().startswith("hardware"):  # ARM
            return line.split(":", 1)[1].strip()
    return platform.processor() or "unknown"


def host_info() -> dict[str, Any]:
    osr = _os_release()
    virt = ""
    if shutil.which("systemd-detect-virt"):
        rc, out = _run(["systemd-detect-virt"], timeout=4)
        virt = out if rc == 0 or out else ""
    return {
        "hostname": socket.gethostname(),
        "fqdn": socket.getfqdn(),
        "os_name": osr.get("PRETTY_NAME") or platform.platform(),
        "os_id": osr.get("ID", ""),
        "os_version": osr.get("VERSION_ID", ""),
        "kernel": platform.release(),
        "architecture": platform.machine(),
        "python": platform.python_version(),
        "cpu_model": _cpu_model(),
        "cpu_cores_physical": psutil.cpu_count(logical=False) or 0,
        "cpu_cores_logical": psutil.cpu_count(logical=True) or 0,
        "boot_time": psutil.boot_time(),
        "virtualization": virt,
        "is_root": is_root(),
        "user": os.environ.get("USER") or _pwd_name(os.geteuid()),
        "container": container_info(),
        "systemd": is_systemd_available()[0],
    }


def _pwd_name(uid: int) -> str:
    try:
        import pwd

        return pwd.getpwuid(uid).pw_name
    except (KeyError, ImportError):
        return str(uid)


def _usable_ip(ip: str) -> bool:
    return bool(ip) and not ip.startswith("127.") and not ip.startswith("169.254.")


def _primary_ip() -> str:
    candidates: list[str] = []
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(0.4)
        sock.connect(("8.8.8.8", 53))
        candidates.append(sock.getsockname()[0])
        sock.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            candidates.append(info[4][0])
    except OSError:
        pass
    try:
        for name, addrs in psutil.net_if_addrs().items():
            if name == "lo":
                continue
            for addr in addrs:
                if addr.family == socket.AF_INET:
                    candidates.append(addr.address)
    except Exception:
        pass
    for ip in candidates:
        if _usable_ip(ip):
            return ip
    return candidates[0] if candidates else "127.0.0.1"


def network_interfaces() -> list[dict[str, Any]]:
    addrs = psutil.net_if_addrs()
    stats = psutil.net_if_stats()
    io = psutil.net_io_counters(pernic=True)
    out: list[dict[str, Any]] = []
    for name, addr_list in sorted(addrs.items()):
        entry: dict[str, Any] = {
            "name": name,
            "is_up": bool(stats.get(name).isup) if name in stats else None,
            "speed_mbps": stats.get(name).speed if name in stats else None,
            "mtu": stats.get(name).mtu if name in stats else None,
            "addresses": [],
            "bytes_sent": io.get(name).bytes_sent if name in io else 0,
            "bytes_recv": io.get(name).bytes_recv if name in io else 0,
            "packets_sent": io.get(name).packets_sent if name in io else 0,
            "packets_recv": io.get(name).packets_recv if name in io else 0,
            "errors_in": io.get(name).errin if name in io else 0,
            "errors_out": io.get(name).errout if name in io else 0,
        }
        for addr in addr_list:
            family = {socket.AF_INET: "ipv4", socket.AF_INET6: "ipv6"}.get(addr.family, "other")
            if addr.family == psutil.AF_LINK:
                family = "mac"
            entry["addresses"].append(
                {"family": family, "address": addr.address, "netmask": addr.netmask, "broadcast": addr.broadcast}
            )
        out.append(entry)
    return out


def default_routes() -> list[dict[str, str]]:
    routes: list[dict[str, str]] = []
    for line in _read("/proc/net/route").splitlines()[1:]:
        parts = line.split()
        if len(parts) < 4:
            continue
        if parts[1] == "00000000" and parts[2] != "00000000":
            routes.append({"interface": parts[0], "destination": "0.0.0.0/0", "gateway": _hex_to_ip(parts[2])})
    try:
        with open("/proc/net/ipv6_route", "r", encoding="utf-8") as fh:
            for line in fh:
                parts = line.split()
                if len(parts) > 3 and parts[0] == "0" * 32 and parts[2] == "00":
                    routes.append({"interface": parts[-1], "destination": "::/0", "gateway": ""})
                    break
    except OSError:
        pass
    return routes


def _hex_to_ip(hex_ip: str) -> str:
    try:
        return socket.inet_ntoa(bytes.fromhex(hex_ip)[::-1])
    except (ValueError, OSError):
        return ""


# --------------------------------------------------------------------------
# Live metrics
# --------------------------------------------------------------------------
_net_state: dict[str, Any] = {"ts": 0.0, "sent": 0, "recv": 0}
_net_rates: dict[str, float] = {"sent_per_sec": 0.0, "recv_per_sec": 0.0}
_disk_state: dict[str, Any] = {"ts": 0.0, "read": 0, "write": 0}
_disk_rates: dict[str, float] = {"read_per_sec": 0.0, "write_per_sec": 0.0}
_last_cpu: dict[str, Any] = {"ts": 0.0, "cpu": None}


def _prime() -> None:
    psutil.cpu_percent(interval=None)
    io = psutil.net_io_counters()
    _net_state.update(ts=time.time(), sent=io.bytes_sent, recv=io.bytes_recv)
    dio = psutil.disk_io_counters()
    if dio:
        _disk_state.update(ts=time.time(), read=dio.read_bytes, write=dio.write_bytes)


def _cpu_snapshot() -> dict[str, float]:
    times = psutil.cpu_times()
    total = sum(times)
    idle = times.idle + getattr(times, "iowait", 0.0)
    now = time.time()
    if _last_cpu["cpu"] is not None and now > _last_cpu["ts"]:
        prev_total, prev_idle = _last_cpu["cpu"]
        delta_total = total - prev_total
        delta_idle = idle - prev_idle
        percent = 0.0 if delta_total <= 0 else max(0.0, min(100.0, (1 - delta_idle / delta_total) * 100))
    else:
        percent = psutil.cpu_percent(interval=None)
    _last_cpu.update(ts=now, cpu=(total, idle))
    return {"percent": round(percent, 1), "per_cpu": psutil.cpu_percent(interval=None, percpu=True)}


def metrics(cfg: Config) -> dict[str, Any]:
    now = time.time()
    cpu = _cpu_snapshot()

    vm = psutil.virtual_memory()
    sm = psutil.swap_memory()

    net = psutil.net_io_counters()
    elapsed = max(0.001, now - float(_net_state["ts"])) if _net_state["ts"] else 0
    if elapsed and _net_state["ts"]:
        sent_rate = max(0.0, (net.bytes_sent - _net_state["sent"]) / elapsed)
        recv_rate = max(0.0, (net.bytes_recv - _net_state["recv"]) / elapsed)
    else:
        sent_rate = recv_rate = 0.0
    _net_state.update(ts=now, sent=net.bytes_sent, recv=net.bytes_recv)
    _net_rates.update(sent_per_sec=sent_rate, recv_per_sec=recv_rate)

    dio = psutil.disk_io_counters()
    read_rate = write_rate = 0.0
    if dio and _disk_state["ts"]:
        d_elapsed = max(0.001, now - float(_disk_state["ts"]))
        read_rate = max(0.0, (dio.read_bytes - _disk_state["read"]) / d_elapsed)
        write_rate = max(0.0, (dio.write_bytes - _disk_state["write"]) / d_elapsed)
        _disk_state.update(ts=now, read=dio.read_bytes, write=dio.write_bytes)
    elif dio:
        _disk_state.update(ts=now, read=dio.read_bytes, write=dio.write_bytes)

    try:
        root_usage = shutil.disk_usage(str(cfg.fs_root_path))
        disk = {
            "path": str(cfg.fs_root_path),
            "total": root_usage.total,
            "used": root_usage.used,
            "free": root_usage.free,
            "percent": round(root_usage.used / root_usage.total * 100, 1) if root_usage.total else 0.0,
        }
    except OSError:
        disk = None

    load = os.getloadavg() if hasattr(os, "getloadavg") else (0.0, 0.0, 0.0)
    container = container_info()
    uptime = now - psutil.boot_time()

    return {
        "ts": now,
        "cpu": cpu,
        "memory": {
            "total": vm.total,
            "used": vm.total - vm.available,
            "available": vm.available,
            "percent": vm.percent,
            "cached": getattr(vm, "cached", 0),
        },
        "swap": {"total": sm.total, "used": sm.used, "percent": sm.percent},
        "disk": disk,
        "disk_io": {"read_per_sec": read_rate, "write_per_sec": write_rate},
        "network": {
            "sent_per_sec": sent_rate,
            "recv_per_sec": recv_rate,
            "bytes_sent": net.bytes_sent,
            "bytes_recv": net.bytes_recv,
        },
        "load": {"1": round(load[0], 2), "5": round(load[1], 2), "15": round(load[2], 2)},
        "uptime": uptime,
        "process_count": len(psutil.pids()),
        "container": container,
        "host_cores": psutil.cpu_count(logical=True) or 1,
        "cpu_quota_cores": container.get("cpu_cores"),
    }


def overview(cfg: Config, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    data = {
        "host": host_info(),
        "metrics": metrics(cfg),
        "interfaces": network_interfaces(),
        "routes": default_routes(),
        "env": {
            "pid": os.getpid(),
            "ppid": os.getppid(),
            "cwd": os.getcwd(),
            "data_dir": str(cfg.data_dir),
            "python_executable": os.path.realpath(os.sys.executable),
            "started_at": _PROCESS_START,
        },
        "primary_ip": _primary_ip(),
    }
    if extra:
        data.update(extra)
    return data


_PROCESS_START = time.time()
_prime()


# --------------------------------------------------------------------------
# Processes
# --------------------------------------------------------------------------
def list_processes(
    *, query: str = "", sort: str = "cpu", limit: int = 60, include_kernel: bool = False
) -> dict[str, Any]:
    limit = max(1, min(int(limit), 500))
    rows: list[dict[str, Any]] = []
    attrs = ["pid", "ppid", "name", "username", "status", "cpu_percent", "memory_percent", "create_time", "cmdline", "num_threads"]
    for proc in psutil.process_iter(attrs, ad_value=None):
        try:
            info = proc.info
            if info["pid"] == 0 and not include_kernel:
                continue
            cmdline = info.get("cmdline") or []
            cmd = " ".join(cmdline)[:400] if cmdline else (info.get("name") or "")
            row = {
                "pid": info["pid"],
                "ppid": info.get("ppid"),
                "name": info.get("name") or "?",
                "user": info.get("username") or "-",
                "status": info.get("status") or "-",
                "cpu": round(info.get("cpu_percent") or 0.0, 1),
                "memory": round(info.get("memory_percent") or 0.0, 1),
                "threads": info.get("num_threads") or 0,
                "started": info.get("create_time") or 0,
                "cmd": cmd,
            }
            if query:
                needle = query.lower()
                haystack = f"{row['name']} {row['cmd']} {row['user']} {row['pid']}".lower()
                if needle not in haystack:
                    continue
            rows.append(row)
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue
    key_map = {"cpu": "cpu", "memory": "memory", "pid": "pid", "name": "name", "started": "started"}
    key = key_map.get(sort, "cpu")
    rows.sort(key=lambda r: r.get(key) or 0, reverse=sort != "pid")
    return {"total": len(rows), "processes": rows[:limit]}


def process_details(pid: int) -> dict[str, Any]:
    proc = psutil.Process(pid)
    with proc.oneshot():
        mem = proc.memory_info()
        data = {
            "pid": proc.pid,
            "ppid": proc.ppid(),
            "name": proc.name(),
            "exe": _safe(lambda: proc.exe()),
            "cwd": _safe(lambda: proc.cwd()),
            "user": _safe(lambda: proc.username()),
            "status": proc.status(),
            "created": proc.create_time(),
            "cpu_percent": proc.cpu_percent(interval=0.05),
            "memory_rss": mem.rss,
            "memory_vms": mem.vms,
            "threads": proc.num_threads(),
            "cmdline": proc.cmdline(),
            "connections": len(_safe(lambda: proc.net_connections(kind="inet"), []) or []),
            "open_files": len(_safe(lambda: proc.open_files(), []) or []),
        }
    return data


def _safe(fn, default=None):
    try:
        return fn()
    except (psutil.Error, OSError):
        return default


# --------------------------------------------------------------------------
# Listening ports
# --------------------------------------------------------------------------
def listening_ports() -> dict[str, Any]:
    ports: list[dict[str, Any]] = []
    denied = False
    try:
        conns = psutil.net_connections(kind="inet")
    except (psutil.AccessDenied, PermissionError):
        conns = []
        denied = True
    for conn in conns:
        if conn.status != psutil.CONN_LISTEN:
            continue
        laddr = conn.laddr
        entry = {
            "address": getattr(laddr, "ip", ""),
            "port": getattr(laddr, "port", 0),
            "family": "ipv6" if getattr(laddr, "ip", "").count(":") > 1 else "ipv4",
            "pid": conn.pid,
            "process": None,
            "user": None,
            "fd": conn.fd,
        }
        if conn.pid:
            try:
                proc = psutil.Process(conn.pid)
                entry["process"] = proc.name()
                entry["user"] = _safe(lambda: proc.username())
                entry["cmdline"] = " ".join(proc.cmdline())[:200]
            except (psutil.Error, OSError):
                pass
        ports.append(entry)
    ports.sort(key=lambda p: p["port"])
    return {
        "available": True,
        "partial": denied,
        "note": "Process ownership requires elevated privileges on some systems." if denied else "",
        "ports": ports,
    }


# --------------------------------------------------------------------------
# Services (systemd)
# --------------------------------------------------------------------------
SERVICE_RE = re.compile(r"^[A-Za-z0-9@:_.\\-]{1,120}$")


def list_services() -> dict[str, Any]:
    ok, reason = is_systemd_available()
    if not ok:
        return {"available": False, "reason": reason, "services": []}
    rc, out = _run(["systemctl", "list-units", "--type=service", "--all", "--no-legend", "--no-pager", "--plain"], timeout=12)
    if rc != 0 and not out:
        return {"available": False, "reason": out or "systemctl failed", "services": []}
    services = []
    for line in out.splitlines():
        line = line.strip().lstrip("●*").strip()
        parts = line.split(None, 4)
        if len(parts) < 4 or not parts[0].endswith(".service"):
            continue
        services.append(
            {
                "name": parts[0],
                "load": parts[1],
                "active": parts[2],
                "sub": parts[3],
                "description": parts[4] if len(parts) > 4 else "",
            }
        )
    return {"available": True, "reason": "", "services": services}


def service_action(name: str, action: str) -> dict[str, Any]:
    if not SERVICE_RE.match(name) or not name.endswith(".service"):
        raise ValueError("Invalid service name")
    if action not in {"start", "stop", "restart", "enable", "disable", "status"}:
        raise ValueError("Invalid service action")
    ok, reason = is_systemd_available()
    if not ok:
        raise RuntimeError(reason)
    cmd = ["systemctl", action, name] if action != "status" else ["systemctl", "status", name, "--no-pager", "--lines=30"]
    rc, out = _run(cmd, timeout=45)
    return {"ok": rc == 0, "exit_code": rc, "output": out[-6000:]}


# --------------------------------------------------------------------------
# Package management
# --------------------------------------------------------------------------
_pkg_cache: dict[str, Any] = {"ts": 0.0, "data": None}
PKG_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9+._:@-]{0,120}$")


def package_manager() -> str | None:
    for name, probe in (
        ("apt", "apt-get"),
        ("dnf", "dnf"),
        ("yum", "yum"),
        ("pacman", "pacman"),
        ("apk", "apk"),
        ("zypper", "zypper"),
    ):
        if shutil.which(probe):
            return name
    return None


def list_packages(query: str = "", force: bool = False) -> dict[str, Any]:
    mgr = package_manager()
    if not mgr:
        return {"available": False, "reason": "No supported package manager found.", "packages": []}
    now = time.time()
    if force or not _pkg_cache["data"] or now - _pkg_cache["ts"] > 60:
        packages: list[dict[str, str]] = []
        if mgr == "apt":
            rc, out = _run(["dpkg-query", "-W", "-f=${Package}\\t${Version}\\t${Status}\\n"], timeout=45)
            if rc == 0:
                for line in out.splitlines():
                    parts = line.split("\t")
                    if len(parts) >= 3 and parts[2].endswith("installed"):
                        packages.append({"name": parts[0], "version": parts[1], "status": "installed"})
            rc, up = _run(["apt", "list", "--upgradable"], timeout=45)
            upgradable = set()
            if rc == 0:
                for line in up.splitlines():
                    if "/" in line and "Listing" not in line:
                        upgradable.add(line.split("/", 1)[0].strip())
            for pkg in packages:
                if pkg["name"] in upgradable:
                    pkg["status"] = "upgradable"
        elif mgr in {"dnf", "yum"}:
            rc, out = _run(["rpm", "-qa", "--qf", "%{NAME}\\t%{VERSION}-%{RELEASE}\\n"], timeout=45)
            if rc == 0:
                for line in out.splitlines():
                    parts = line.split("\t")
                    if len(parts) >= 2:
                        packages.append({"name": parts[0], "version": parts[1], "status": "installed"})
        elif mgr == "pacman":
            rc, out = _run(["pacman", "-Q"], timeout=45)
            if rc == 0:
                for line in out.splitlines():
                    parts = line.split()
                    if len(parts) >= 2:
                        packages.append({"name": parts[0], "version": parts[1], "status": "installed"})
        elif mgr == "apk":
            rc, out = _run(["apk", "info", "-v"], timeout=45)
            if rc == 0:
                for line in out.splitlines():
                    if "-" in line:
                        name, _, ver = line.rpartition("-")
                        packages.append({"name": name, "version": ver, "status": "installed"})
        elif mgr == "zypper":
            rc, out = _run(["rpm", "-qa", "--qf", "%{NAME}\\t%{VERSION}\\n"], timeout=45)
            if rc == 0:
                for line in out.splitlines():
                    parts = line.split("\t")
                    if len(parts) >= 2:
                        packages.append({"name": parts[0], "version": parts[1], "status": "installed"})
        packages.sort(key=lambda p: p["name"].lower())
        _pkg_cache.update(ts=now, data=packages)
    packages = _pkg_cache["data"] or []
    if query:
        needle = query.lower()
        packages = [p for p in packages if needle in p["name"].lower()]
    return {
        "available": True,
        "manager": mgr,
        "is_root": is_root(),
        "total": len(packages),
        "packages": packages[:2000],
        "truncated": len(packages) > 2000,
    }


def package_action(name: str, action: str) -> dict[str, Any]:
    mgr = package_manager()
    if not mgr:
        raise RuntimeError("No supported package manager found.")
    if not PKG_NAME_RE.match(name):
        raise ValueError("Invalid package name")
    if not is_root():
        raise PermissionError("Package management requires the panel to run as root.")
    if action not in {"install", "remove"}:
        raise ValueError("Invalid package action")
    if mgr == "apt":
        cmd = ["apt-get", action if action == "install" else "remove", "-y"] + (["--no-install-recommends"] if action == "install" else []) + [name]
        env = {**os.environ, "DEBIAN_FRONTEND": "noninteractive"}
    elif mgr in {"dnf", "yum"}:
        cmd = [mgr, action, "-y", name]
    elif mgr == "pacman":
        cmd = ["pacman", "-S" if action == "install" else "-R", "--noconfirm", name]
    elif mgr == "apk":
        cmd = ["apk", action if action == "install" else "del", name]
    else:
        cmd = ["zypper", "--non-interactive", "install" if action == "install" else "remove", name]
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=600,
        check=False,
        env=env if mgr == "apt" else None,
    )
    _pkg_cache["ts"] = 0
    return {
        "ok": proc.returncode == 0,
        "exit_code": proc.returncode,
        "command": " ".join(cmd),
        "output": ((proc.stdout or "") + (proc.stderr or ""))[-12000:],
    }


# --------------------------------------------------------------------------
# Logs
# --------------------------------------------------------------------------
LOG_SOURCES = [
    {"id": "syslog", "name": "System log (syslog)", "path": "/var/log/syslog"},
    {"id": "messages", "name": "Kernel / system messages", "path": "/var/log/messages"},
    {"id": "auth", "name": "Authentication log", "path": "/var/log/auth.log"},
    {"id": "kern", "name": "Kernel log", "path": "/var/log/kern.log"},
    {"id": "dpkg", "name": "Package log", "path": "/var/log/dpkg.log"},
    {"id": "nginx-access", "name": "nginx access", "path": "/var/log/nginx/access.log"},
    {"id": "nginx-error", "name": "nginx error", "path": "/var/log/nginx/error.log"},
]


def log_sources(cfg: Config) -> dict[str, Any]:
    items = []
    seen: set[str] = set()
    for src in LOG_SOURCES:
        path = Path(src["path"])
        if path.exists() and path.is_file():
            try:
                stat = path.stat()
            except OSError:
                continue
            seen.add(src["path"])
            items.append({**src, "size": stat.st_size, "mtime": stat.st_mtime, "kind": "file"})
    # Additional /var/log/*.log files
    try:
        for entry in sorted(Path("/var/log").iterdir()):
            if entry.is_file() and entry.suffix == ".log" and str(entry) not in seen:
                try:
                    stat = entry.stat()
                except OSError:
                    continue
                items.append(
                    {
                        "id": f"file:{entry}",
                        "name": entry.name,
                        "path": str(entry),
                        "size": stat.st_size,
                        "mtime": stat.st_mtime,
                        "kind": "file",
                    }
                )
    except OSError:
        pass
    for extra in (cfg.log_dir / "panel.log",):
        if extra.exists():
            try:
                stat = extra.stat()
                items.append(
                    {
                        "id": "panel",
                        "name": "PRIME TERMINAL service log",
                        "path": str(extra),
                        "size": stat.st_size,
                        "mtime": stat.st_mtime,
                        "kind": "file",
                    }
                )
            except OSError:
                pass
    journal_available = is_systemd_available()[0] and shutil.which("journalctl") is not None
    return {
        "sources": items,
        "journal": {
            "available": bool(journal_available),
            "reason": "" if journal_available else "systemd journal is not available in this environment.",
        },
    }


def read_log(cfg: Config, source: str, lines: int = 300) -> dict[str, Any]:
    lines = max(1, min(int(lines), 5000))
    if source == "journal" or source.startswith("journal:"):
        ok, reason = is_systemd_available()
        if not ok or shutil.which("journalctl") is None:
            raise RuntimeError(reason or "journalctl is not available")
        unit = source.split(":", 1)[1] if ":" in source else ""
        cmd = ["journalctl", "--no-pager", "-n", str(lines), "-o", "short-iso"]
        if unit:
            if not SERVICE_RE.match(unit):
                raise ValueError("Invalid unit name")
            cmd.append("-u")
            cmd.append(unit)
        rc, out = _run(cmd, timeout=20)
        return {"source": source, "content": out, "lines": len(out.splitlines()), "exit_code": rc}
    # file sources: only /var/log and the panel data directory
    allowed_roots = [Path("/var/log"), cfg.log_dir]
    path = Path(source[5:]) if source.startswith("file:") else Path(source)
    try:
        real = Path(os.path.realpath(path))
    except OSError as exc:
        raise ValueError(f"Invalid log path: {exc}") from exc
    if not any(_is_relative_to(real, Path(os.path.realpath(root))) for root in allowed_roots):
        raise PermissionError("Log path is outside the permitted log directories")
    if not real.is_file():
        raise FileNotFoundError(f"Log file not found: {real}")
    size = real.stat().st_size
    chunk = min(size, 2 * 1024 * 1024)
    with open(real, "rb") as fh:
        fh.seek(size - chunk)
        data = fh.read()
    text = data.decode("utf-8", errors="replace")
    tail = "\n".join(text.splitlines()[-lines:])
    return {"source": str(real), "content": tail, "lines": len(tail.splitlines()), "size": size}


def _is_relative_to(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


# --------------------------------------------------------------------------
# Network diagnostics
# --------------------------------------------------------------------------
HOST_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,252})$")


def validate_host(host: str) -> str:
    host = (host or "").strip()
    if not HOST_RE.match(host):
        raise ValueError("Invalid hostname or IP address")
    return host


def ping(host: str, count: int = 4) -> dict[str, Any]:
    host = validate_host(host)
    count = max(1, min(int(count), 10))
    if shutil.which("ping") is None:
        # Fallback: raw TCP connect timing is not ICMP, so report honestly.
        raise RuntimeError("The 'ping' utility is not installed on this server.")
    rc, out = _run(["ping", "-c", str(count), "-W", "2", host], timeout=count * 3 + 5)
    return {"host": host, "ok": rc == 0, "output": out}


def traceroute(host: str) -> dict[str, Any]:
    host = validate_host(host)
    tool = "traceroute" if shutil.which("traceroute") else ("tracepath" if shutil.which("tracepath") else None)
    if not tool:
        raise RuntimeError("Neither traceroute nor tracepath is installed on this server.")
    cmd = [tool, "-m", "20", host] if tool == "traceroute" else [tool, "-m", "20", host]
    rc, out = _run(cmd, timeout=60)
    return {"host": host, "ok": rc == 0, "output": out}


def dns_lookup(host: str) -> dict[str, Any]:
    host = validate_host(host)
    started = time.time()
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        return {"host": host, "ok": False, "error": str(exc), "records": [], "elapsed_ms": round((time.time() - started) * 1000, 1)}
    records = sorted({(("ipv6" if info[0] == socket.AF_INET6 else "ipv4"), info[4][0]) for info in infos})
    return {
        "host": host,
        "ok": True,
        "records": [{"type": t, "value": v} for t, v in records],
        "elapsed_ms": round((time.time() - started) * 1000, 1),
    }


# --------------------------------------------------------------------------
# SSH keys
# --------------------------------------------------------------------------
SSH_KEY_RE = re.compile(
    r"^(ssh-(rsa|ed25519)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)"
    r"\s+AAAA[A-Za-z0-9+/]+={0,3}(\s+.+)?$"
)


def ssh_target(scope: str) -> tuple[str, Path]:
    """Resolve a scope such as ``self`` or ``root`` to its authorized_keys file."""
    import pwd

    if scope in {"", "self", "panel"}:
        username = _pwd_name(os.geteuid())
        home = Path(os.path.expanduser("~"))
    elif scope == "root":
        username = "root"
        home = Path("/root")
    elif re.match(r"^[a-z_][a-z0-9_-]{0,31}$", scope):
        try:
            entry = pwd.getpwnam(scope)
        except KeyError as exc:
            raise ValueError(f"User '{scope}' does not exist") from exc
        username = scope
        home = Path(entry.pw_dir)
    else:
        raise ValueError("Invalid SSH key scope")
    return username, home / ".ssh" / "authorized_keys"


def read_ssh_keys(scope: str) -> dict[str, Any]:
    username, path = ssh_target(scope)
    keys: list[dict[str, Any]] = []
    if path.exists():
        try:
            content = path.read_text("utf-8", errors="replace")
        except PermissionError as exc:
            raise PermissionError(f"Cannot read {path}: permission denied") from exc
        for index, line in enumerate(content.splitlines()):
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            parts = stripped.split()
            comment = " ".join(parts[2:]) if len(parts) > 2 else ""
            keywords = ""
            if stripped.startswith(("command=", "no-", "restrict", "from=", "environment=")):
                keyword_part = stripped.split(" ", 1)[0]
                keys.append(
                    {
                        "index": index,
                        "raw": stripped,
                        "type": "restricted",
                        "comment": keyword_part[:120],
                        "fingerprint": "",
                    }
                )
                continue
            keys.append(
                {
                    "index": index,
                    "raw": stripped,
                    "type": parts[0] if parts else "unknown",
                    "comment": comment,
                    "fingerprint": _fingerprint(parts),
                }
            )
    writable = _is_writable(path.parent) if path.exists() else _is_writable(path.parent) or _can_create(path.parent)
    return {
        "scope": scope,
        "user": username,
        "path": str(path),
        "exists": path.exists(),
        "writable": writable,
        "keys": keys,
    }


def _can_create(directory: Path) -> bool:
    probe = directory
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    return os.access(probe, os.W_OK)


def _is_writable(path: Path) -> bool:
    return path.exists() and os.access(path, os.W_OK)


def _fingerprint(parts: list[str]) -> str:
    if len(parts) < 2:
        return ""
    import base64
    import hashlib

    try:
        blob = base64.b64decode(parts[1])
    except (ValueError, TypeError):
        return ""
    digest = hashlib.sha256(blob).digest()
    return "SHA256:" + base64.b64encode(digest).decode().rstrip("=")


def add_ssh_key(scope: str, key: str) -> dict[str, Any]:
    key = (key or "").strip()
    if len(key) > 8192 or "\n" in key or "\r" in key:
        raise ValueError("Key must be a single line")
    # Allow leading options (e.g. no-pty, from=...) before the key type.
    candidate = key
    if not SSH_KEY_RE.match(candidate):
        # try stripping leading options
        parts = key.split()
        for idx in range(1, min(len(parts), 6)):
            candidate = " ".join(parts[idx:])
            if SSH_KEY_RE.match(candidate):
                break
        else:
            raise ValueError("That does not look like a valid SSH public key")
    username, path = ssh_target(scope)
    if not _can_create(path.parent):
        raise PermissionError(f"No permission to write {path.parent}")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    existing = path.read_text("utf-8", errors="replace") if path.exists() else ""
    if candidate in existing:
        raise ValueError("That key is already authorised")
    with open(path, "a", encoding="utf-8") as fh:
        if existing and not existing.endswith("\n"):
            fh.write("\n")
        fh.write(candidate + "\n")
    try:
        os.chmod(path, 0o600)
        os.chmod(path.parent, 0o700)
    except OSError:
        pass
    return {"ok": True, "path": str(path), "user": username}


def remove_ssh_key(scope: str, index: int) -> dict[str, Any]:
    username, path = ssh_target(scope)
    if not path.exists():
        raise FileNotFoundError("authorized_keys does not exist")
    lines = path.read_text("utf-8", errors="replace").splitlines()
    if index < 0 or index >= len(lines):
        raise ValueError("Invalid key index")
    removed = lines.pop(index)
    path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return {"ok": True, "removed": removed[:200], "user": username}


# --------------------------------------------------------------------------
# Python execution
# --------------------------------------------------------------------------
def run_python(code: str, timeout: int = 30) -> dict[str, Any]:
    import tempfile

    if not isinstance(code, str) or not code.strip():
        raise ValueError("No code supplied")
    if len(code) > 200_000:
        raise ValueError("Script is too large (200 KB limit)")
    timeout = max(1, min(int(timeout), 120))
    started = time.time()
    with tempfile.TemporaryDirectory(prefix="prime-py-") as tmp:
        script = Path(tmp) / "script.py"
        script.write_text(code, encoding="utf-8")
        try:
            proc = subprocess.run(
                [os.sys.executable, str(script)],
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=tmp,
                check=False,
                env={**os.environ, "PYTHONUNBUFFERED": "1", "PRIME_TERMINAL": "1"},
            )
            stdout, stderr, rc = proc.stdout, proc.stderr, proc.returncode
        except subprocess.TimeoutExpired as exc:
            stdout = (exc.stdout or b"").decode("utf-8", "replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
            stderr = (exc.stderr or b"").decode("utf-8", "replace") if isinstance(exc.stderr, bytes) else (exc.stderr or "")
            return {
                "ok": False,
                "timed_out": True,
                "exit_code": None,
                "stdout": stdout[-20000:],
                "stderr": (stderr + f"\nExecution timed out after {timeout}s")[-20000:],
                "duration_ms": round((time.time() - started) * 1000, 1),
            }
    return {
        "ok": rc == 0,
        "timed_out": False,
        "exit_code": rc,
        "stdout": stdout[-20000:],
        "stderr": stderr[-20000:],
        "duration_ms": round((time.time() - started) * 1000, 1),
    }


# --------------------------------------------------------------------------
# Disks & mounts
# --------------------------------------------------------------------------
def disks() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for part in psutil.disk_partitions(all=False):
        try:
            usage = psutil.disk_usage(part.mountpoint)
        except (PermissionError, OSError):
            continue
        out.append(
            {
                "device": part.device,
                "mountpoint": part.mountpoint,
                "fstype": part.fstype,
                "total": usage.total,
                "used": usage.used,
                "free": usage.free,
                "percent": usage.percent,
            }
        )
    out.sort(key=lambda d: d["mountpoint"])
    return out
