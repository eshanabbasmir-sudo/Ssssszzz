"""System information and server-management APIs (all backed by real OS data)."""

from __future__ import annotations

import time
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from .. import db, system_info
from ..config import Config
from ..security import AuthUser, client_ip, require_csrf, require_user

router = APIRouter(prefix="/api/system", dependencies=[Depends(require_user), Depends(require_csrf)])


def _cfg(request: Request) -> Config:
    return request.app.state.cfg


def _audit(request: Request, user: AuthUser, action: str, detail: str = "") -> None:
    db.audit(user.username, action, detail, client_ip(request, _cfg(request)))


# --------------------------------------------------------------------------
# Overview & metrics
# --------------------------------------------------------------------------
@router.get("/overview")
def overview(request: Request):
    cfg = _cfg(request)
    manager = request.app.state.terminals
    panel = {
        "version": request.app.state.version,
        "started_at": request.app.state.started_at,
        "uptime": time.time() - request.app.state.started_at,
        "url_port": cfg.port,
        "sessions_total": len(manager.sessions),
        "terminal_sessions": [s.info() for s in manager.sessions.values()],
    }
    capabilities = request.app.state.capabilities
    return system_info.overview(cfg, extra={"panel": panel, "capabilities": capabilities})


@router.get("/metrics")
def metrics(request: Request):
    return system_info.metrics(_cfg(request))


@router.get("/host")
def host():
    return system_info.host_info()


@router.get("/capabilities")
def capabilities(request: Request):
    return request.app.state.capabilities


@router.get("/disks")
def disks():
    return {"disks": system_info.disks()}


@router.get("/network")
def network(request: Request):
    return {
        "interfaces": system_info.network_interfaces(),
        "routes": system_info.default_routes(),
        "primary_ip": system_info._primary_ip(),
    }


# --------------------------------------------------------------------------
# Processes
# --------------------------------------------------------------------------
@router.get("/processes")
def processes(
    q: str = Query(default="", max_length=200),
    sort: Literal["cpu", "memory", "pid", "name", "started"] = "cpu",
    limit: int = Query(default=80, ge=1, le=500),
):
    return system_info.list_processes(query=q, sort=sort, limit=limit)


@router.get("/processes/{pid}")
def process(pid: int):
    if pid < 1:
        raise HTTPException(400, "Invalid PID")
    try:
        return system_info.process_details(pid)
    except Exception as exc:
        raise HTTPException(404, f"Cannot read process {pid}: {exc}")


class KillBody(BaseModel):
    signal: Literal["TERM", "KILL", "HUP", "INT"] = "TERM"


@router.post("/processes/{pid}/kill")
def kill_process(request: Request, pid: int, body: KillBody, user: AuthUser = Depends(require_user)):
    import os
    import signal as sigmod

    if pid < 2:
        raise HTTPException(400, "Refusing to signal PID 1 or invalid PIDs")
    if pid == os.getpid():
        raise HTTPException(400, "Refusing to signal the panel itself")
    if not request.app.state.cfg.debug and pid == os.getppid() and os.geteuid() != 0:
        pass
    sig = getattr(sigmod, f"SIG{body.signal}")
    try:
        os.kill(pid, sig)
    except ProcessLookupError:
        raise HTTPException(404, f"Process {pid} does not exist")
    except PermissionError:
        raise HTTPException(403, f"Permission denied signalling {pid} (needs root or the same owner)")
    except OSError as exc:
        raise HTTPException(400, f"Cannot signal {pid}: {exc}")
    _audit(request, user, "process.kill", f"pid={pid} signal={body.signal}")
    return {"ok": True, "pid": pid, "signal": body.signal}


# --------------------------------------------------------------------------
# Ports
# --------------------------------------------------------------------------
@router.get("/ports")
def ports():
    return system_info.listening_ports()


# --------------------------------------------------------------------------
# Services
# --------------------------------------------------------------------------
@router.get("/services")
def services():
    return system_info.list_services()


class ServiceActionBody(BaseModel):
    action: Literal["start", "stop", "restart", "enable", "disable", "status"]


@router.post("/services/{name}/action")
def service_action(
    request: Request, name: str, body: ServiceActionBody, user: AuthUser = Depends(require_user)
):
    try:
        result = system_info.service_action(name, body.action)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except RuntimeError as exc:
        raise HTTPException(503, str(exc))
    _audit(request, user, f"service.{body.action}", name)
    return result


# --------------------------------------------------------------------------
# Packages
# --------------------------------------------------------------------------
@router.get("/packages")
def packages(q: str = Query(default="", max_length=120), refresh: bool = False):
    return system_info.list_packages(q, force=refresh)


class PackageActionBody(BaseModel):
    action: Literal["install", "remove"]


@router.post("/packages/{name}/action")
def package_action(
    request: Request, name: str, body: PackageActionBody, user: AuthUser = Depends(require_user)
):
    try:
        result = system_info.package_action(name, body.action)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except PermissionError as exc:
        raise HTTPException(403, str(exc))
    except RuntimeError as exc:
        raise HTTPException(503, str(exc))
    except Exception as exc:  # subprocess timeouts etc.
        raise HTTPException(500, f"Package operation failed: {exc}")
    _audit(request, user, f"package.{body.action}", f"{name} exit={result.get('exit_code')}")
    return result


# --------------------------------------------------------------------------
# Logs
# --------------------------------------------------------------------------
@router.get("/logs")
def logs(request: Request):
    return system_info.log_sources(_cfg(request))


@router.get("/logs/read")
def read_log(request: Request, source: str = Query(..., max_length=400), lines: int = Query(default=300, ge=1, le=5000)):
    try:
        return system_info.read_log(_cfg(request), source, lines)
    except PermissionError as exc:
        raise HTTPException(403, str(exc))
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc))
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(400, str(exc))


# --------------------------------------------------------------------------
# Network diagnostics
# --------------------------------------------------------------------------
@router.get("/network/ping")
def ping(host: str = Query(..., min_length=1, max_length=253), count: int = Query(default=4, ge=1, le=10)):
    try:
        return system_info.ping(host, count)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(400, str(exc))


@router.get("/network/traceroute")
def traceroute(host: str = Query(..., min_length=1, max_length=253)):
    try:
        return system_info.traceroute(host)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(400, str(exc))


@router.get("/network/dns")
def dns(host: str = Query(..., min_length=1, max_length=253)):
    try:
        return system_info.dns_lookup(host)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


# --------------------------------------------------------------------------
# SSH keys
# --------------------------------------------------------------------------
@router.get("/ssh/keys")
def ssh_keys(scope: str = Query(default="self", max_length=64)):
    try:
        return system_info.read_ssh_keys(scope)
    except PermissionError as exc:
        raise HTTPException(403, str(exc))
    except ValueError as exc:
        raise HTTPException(400, str(exc))


class SshKeyBody(BaseModel):
    scope: str = Field(default="self", max_length=64)
    key: str = Field(min_length=20, max_length=8192)


@router.post("/ssh/keys")
def add_ssh_key(request: Request, body: SshKeyBody, user: AuthUser = Depends(require_user)):
    try:
        result = system_info.add_ssh_key(body.scope, body.key)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except PermissionError as exc:
        raise HTTPException(403, str(exc))
    _audit(request, user, "ssh.key.added", f"scope={body.scope} user={result.get('user')}")
    return result


class SshKeyDeleteBody(BaseModel):
    scope: str = Field(default="self", max_length=64)
    index: int = Field(ge=0, le=100000)


@router.post("/ssh/keys/delete")
def delete_ssh_key(request: Request, body: SshKeyDeleteBody, user: AuthUser = Depends(require_user)):
    try:
        result = system_info.remove_ssh_key(body.scope, body.index)
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(400, str(exc))
    except PermissionError as exc:
        raise HTTPException(403, str(exc))
    _audit(request, user, "ssh.key.removed", f"scope={body.scope} index={body.index}")
    return result


# --------------------------------------------------------------------------
# Python runner
# --------------------------------------------------------------------------
class PythonBody(BaseModel):
    code: str = Field(min_length=1, max_length=200_000)
    timeout: int = Field(default=30, ge=1, le=120)


@router.post("/python/run")
def run_python(request: Request, body: PythonBody, user: AuthUser = Depends(require_user)):
    try:
        result = system_info.run_python(body.code, body.timeout)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    _audit(request, user, "python.run", f"exit={result.get('exit_code')} {result.get('duration_ms')}ms")
    return result


# --------------------------------------------------------------------------
# Audit trail
# --------------------------------------------------------------------------
@router.get("/audit")
def audit(request: Request, limit: int = Query(default=100, ge=1, le=1000), q: str = Query(default="", max_length=120)):
    if q:
        rows = db.query(
            "SELECT * FROM audit WHERE action LIKE ? OR detail LIKE ? OR username LIKE ? ORDER BY ts DESC LIMIT ?",
            (f"%{q}%", f"%{q}%", f"%{q}%", limit),
        )
    else:
        rows = db.query("SELECT * FROM audit ORDER BY ts DESC LIMIT ?", (limit,))
    return {
        "entries": [
            {
                "id": r["id"],
                "ts": r["ts"],
                "username": r["username"],
                "action": r["action"],
                "detail": r["detail"],
                "ip": r["ip"],
            }
            for r in rows
        ]
    }


# --------------------------------------------------------------------------
# Panel configuration (read-only) + log tail for the panel process
# --------------------------------------------------------------------------
@router.get("/panel")
def panel_info(request: Request):
    cfg = _cfg(request)
    return {
        "config": cfg.to_public_dict(),
        "capabilities": request.app.state.capabilities,
        "version": request.app.state.version,
    }


@router.get("/health")
def health():
    return {"ok": True, "ts": time.time()}
