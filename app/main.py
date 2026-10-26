"""PRIME TERMINAL application entry point.

Run with:  python3 -m app.main
The service wrapper (panel.sh) starts this with the data directory set by
PRIME_DATA_DIR.
"""

from __future__ import annotations

import logging
import os
import shutil
import sys
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import APP_NAME, __version__, db, system_info
from .config import STATIC_DIR, Config, load_config, save_config
from .routers import auth as auth_router
from .routers import files as files_router
from .routers import system as system_router
from .routers import terminal as terminal_router
from .terminal import TerminalManager

log = logging.getLogger("prime_terminal")

CSP = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; "
    "font-src 'self' data:; "
    "connect-src 'self' ws: wss:; "
    "frame-ancestors 'self'; "
    "base-uri 'self'; "
    "form-action 'self'; "
    "object-src 'none'"
)


def setup_logging(cfg: Config) -> None:
    cfg.log_dir.mkdir(parents=True, exist_ok=True)
    root = logging.getLogger()
    root.setLevel(logging.DEBUG if cfg.debug else logging.INFO)
    for handler in list(root.handlers):
        root.removeHandler(handler)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    file_handler = RotatingFileHandler(
        cfg.log_dir / "panel.log", maxBytes=5 * 1024 * 1024, backupCount=4, encoding="utf-8"
    )
    file_handler.setFormatter(fmt)
    root.addHandler(file_handler)
    stream = logging.StreamHandler(sys.stdout)
    stream.setFormatter(fmt)
    root.addHandler(stream)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.error").setLevel(logging.INFO)


def detect_capabilities(cfg: Config) -> dict[str, Any]:
    container = system_info.container_info()
    systemd_ok, systemd_reason = system_info.is_systemd_available()
    mgr = system_info.package_manager()
    has_pty = True
    try:
        import pty  # noqa: F401
    except ImportError:  # pragma: no cover
        has_pty = False
    ssh_writable = False
    try:
        ssh_writable = system_info.read_ssh_keys("self").get("writable", False)
    except Exception:
        ssh_writable = False
    return {
        "terminal": {
            "available": has_pty,
            "reason": "" if has_pty else "The Python 'pty' module is unavailable on this platform.",
            "shell": cfg.shell,
        },
        "filesystem": {
            "available": True,
            "root": str(cfg.fs_root_path),
            "writable": os.access(str(cfg.fs_root_path), os.W_OK),
            "max_upload_mb": cfg.max_upload_mb,
        },
        "services": {
            "available": systemd_ok,
            "reason": systemd_reason,
        },
        "packages": {
            "available": bool(mgr),
            "manager": mgr,
            "can_modify": bool(mgr) and os.geteuid() == 0,
            "reason": ""
            if mgr
            else "No supported package manager (apt/dnf/yum/pacman/apk/zypper) was found.",
        },
        "root": {
            "is_root": os.geteuid() == 0,
            "note": (
                "The panel runs as root and can manage the whole system."
                if os.geteuid() == 0
                else "The panel runs unprivileged; privileged actions will be refused."
            ),
        },
        "container": container,
        "logs": {
            "journal": bool(shutil.which("journalctl")) and systemd_ok,
            "journal_reason": "" if bool(shutil.which("journalctl")) and systemd_ok else "systemd journal unavailable",
        },
        "diagnostics": {
            "ping": shutil.which("ping") is not None,
            "traceroute": shutil.which("traceroute") is not None or shutil.which("tracepath") is not None,
        },
        "ssh_keys": {
            "writable": ssh_writable,
            "reason": "" if ssh_writable else "The authorized_keys file for this user is not writable by the panel.",
        },
        "python_runner": {"available": True, "executable": os.path.realpath(sys.executable)},
    }


def create_app() -> FastAPI:
    cfg = load_config()
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    cfg.log_dir.mkdir(parents=True, exist_ok=True)
    setup_logging(cfg)
    db.init_db(cfg.db_path)
    db.prune(cfg.audit_retention_days)

    # Remove stale temporary artefacts (aborted uploads/archives).
    tmp_dir = cfg.data_dir / "tmp"
    if tmp_dir.is_dir():
        cutoff = time.time() - 6 * 3600
        for stale in tmp_dir.iterdir():
            try:
                if stale.stat().st_mtime < cutoff:
                    stale.unlink()
            except OSError:
                continue

    if not db.get_setting("instance_id"):
        import secrets

        db.set_setting("instance_id", secrets.token_hex(16))
    if not (cfg.data_dir / "config.json").exists():
        save_config(cfg)

    app = FastAPI(
        title=APP_NAME,
        version=__version__,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        debug=False,
    )
    app.state.cfg = cfg
    app.state.version = __version__
    app.state.started_at = time.time()
    app.state.terminals = TerminalManager(cfg)
    app.state.capabilities = detect_capabilities(cfg)

    # ---- middleware ---------------------------------------------------
    @app.middleware("http")
    async def security_and_logging(request: Request, call_next):
        started = time.perf_counter()
        if request.url.path.startswith("/api/files/upload"):
            response = await call_next(request)
        else:
            length = request.headers.get("content-length")
            if length and length.isdigit() and int(length) > 8 * 1024 * 1024:
                return JSONResponse({"detail": "Request body too large"}, status_code=413)
            response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        if not cfg.allow_framing:
            response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
        frame_policy = "frame-ancestors *" if cfg.allow_framing else "frame-ancestors 'self'"
        response.headers.setdefault(
            "Content-Security-Policy",
            CSP.replace("frame-ancestors 'self'", frame_policy),
        )
        if request.url.scheme == "https":
            response.headers.setdefault("Strict-Transport-Security", "max-age=31536000")
        elapsed_ms = (time.perf_counter() - started) * 1000
        if request.url.path.startswith("/api/") and response.status_code >= 400:
            log.info(
                "%s %s -> %s (%.0fms) %s",
                request.method,
                request.url.path,
                response.status_code,
                elapsed_ms,
                (request.client.host if request.client else "-"),
            )
        return response

    @app.exception_handler(HTTPException)
    async def http_exc(request: Request, exc: HTTPException):
        return JSONResponse(
            {"detail": exc.detail if isinstance(exc.detail, str) else exc.detail},
            status_code=exc.status_code,
            headers=dict(exc.headers or {}),
        )

    @app.exception_handler(RequestValidationError)
    async def validation_exc(request: Request, exc: RequestValidationError):
        return JSONResponse(
            {"detail": "Invalid request", "errors": exc.errors()[:5]},
            status_code=422,
        )

    @app.exception_handler(Exception)
    async def unhandled_exc(request: Request, exc: Exception):
        log.exception("Unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(
            {"detail": f"Internal error: {exc.__class__.__name__}"},
            status_code=500,
        )

    # ---- lifecycle ----------------------------------------------------
    @app.on_event("startup")
    async def on_startup():
        app.state.terminals.start()
        log.info("%s %s started on %s:%s (data: %s)", APP_NAME, __version__, cfg.host, cfg.port, cfg.data_dir)

    @app.on_event("shutdown")
    async def on_shutdown():
        app.state.terminals.shutdown()
        log.info("%s shutting down", APP_NAME)

    # ---- routes -------------------------------------------------------
    app.include_router(auth_router.router)
    app.include_router(system_router.router)
    app.include_router(files_router.router)
    app.include_router(terminal_router.router)

    @app.get("/healthz")
    def healthz():
        return {"ok": True, "app": "prime-terminal", "version": __version__, "ts": time.time()}

    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    index_file = STATIC_DIR / "index.html"

    @app.get("/")
    def index():
        return FileResponse(str(index_file), headers={"Cache-Control": "no-store"})

    @app.get("/favicon.svg")
    def favicon():
        return FileResponse(str(STATIC_DIR / "favicon.svg"), media_type="image/svg+xml")

    @app.get("/manifest.webmanifest")
    def manifest():
        return FileResponse(str(STATIC_DIR / "manifest.webmanifest"), media_type="application/manifest+json")

    @app.get("/sw.js")
    def service_worker():
        return FileResponse(str(STATIC_DIR / "sw.js"), media_type="application/javascript")

    @app.get("/{path:path}")
    def spa(path: str):
        if path.startswith(("api/", "ws/", "static/")):
            raise HTTPException(404, "Not found")
        candidate = (STATIC_DIR / path).resolve()
        if candidate.is_file() and STATIC_DIR in candidate.parents:
            return FileResponse(str(candidate))
        return FileResponse(str(index_file), headers={"Cache-Control": "no-store"})

    return app


app = create_app()


def main() -> None:
    import uvicorn

    cfg: Config = app.state.cfg
    kwargs: dict[str, Any] = {
        "host": cfg.host,
        "port": cfg.port,
        "log_level": "info" if not cfg.debug else "debug",
        "access_log": False,
        "proxy_headers": cfg.trust_proxy_headers,
        "forwarded_allow_ips": "127.0.0.1" if cfg.trust_proxy_headers else None,
        "timeout_keep_alive": 30,
        "ws_ping_interval": 25,
        "ws_ping_timeout": 60,
    }
    if cfg.tls_cert and cfg.tls_key:
        kwargs["ssl_certfile"] = cfg.tls_cert
        kwargs["ssl_keyfile"] = cfg.tls_key
    uvicorn.run(app, **kwargs)


if __name__ == "__main__":
    main()
