"""Structured configuration for PRIME TERMINAL.

The panel keeps its mutable state (database, config, logs, pid file) inside a
single data directory.  The installer writes ``config.json`` there; the
application never needs write access to the source tree at runtime.
"""

from __future__ import annotations

import json
import os
import secrets
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

APP_ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = Path(__file__).resolve().parent / "static"


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def default_data_dir() -> Path:
    return Path(os.environ.get("PRIME_DATA_DIR", str(APP_ROOT / "data")))


@dataclass
class Config:
    """Persisted panel configuration."""

    host: str = "0.0.0.0"
    port: int = 8080
    # Filesystem root exposed by the file manager.  "/" is normal for an
    # administrative control panel; narrow it to sandbox a deployment.
    fs_root: str = "/"
    # Extra paths the file API may never modify or delete (read is allowed).
    protected_paths: list[str] = field(
        default_factory=lambda: [
            "/proc", "/sys", "/dev", "/boot", "/lib", "/lib64", "/bin", "/sbin", "/usr/bin", "/usr/sbin",
            # Authentication and SSH configuration are readable but never
            # editable or deletable from the panel.
            "/etc/ssh", "/etc/shadow", "/etc/gshadow", "/etc/passwd", "/etc/group",
            "/etc/sudoers", "/etc/sudoers.d",
        ]
    )
    max_upload_mb: int = 2048
    max_edit_bytes: int = 4 * 1024 * 1024
    session_hours: float = 12.0
    terminal_idle_minutes: int = 90
    max_terminal_sessions: int = 12
    terminal_shell: str = ""
    terminal_scrollback_kb: int = 256
    login_max_attempts: int = 5
    login_window_minutes: int = 15
    # Optional TLS; a reverse proxy is the recommended deployment.
    tls_cert: str = ""
    tls_key: str = ""
    behind_proxy: bool = False
    trust_proxy_headers: bool = False
    # Permit embedding the panel in a cross-origin iframe (e.g. a hosted
    # preview pane). Off by default because it weakens clickjacking
    # protection; never enable it on a public deployment.
    allow_framing: bool = False
    debug: bool = False
    panel_name: str = "PRIME TERMINAL"
    audit_retention_days: int = 90
    install_token: str = ""

    # ---- derived -----------------------------------------------------
    @property
    def data_dir(self) -> Path:
        return default_data_dir()

    @property
    def db_path(self) -> Path:
        return self.data_dir / "panel.db"

    @property
    def log_dir(self) -> Path:
        return self.data_dir / "logs"

    @property
    def fs_root_path(self) -> Path:
        return Path(os.path.realpath(self.fs_root or "/"))

    @property
    def shell(self) -> str:
        if self.terminal_shell:
            return self.terminal_shell
        for candidate in (os.environ.get("SHELL"), "/bin/bash", "/bin/sh"):
            if candidate and os.path.exists(candidate):
                return candidate
        return "/bin/sh"

    def resolved_protected(self) -> list[Path]:
        out: list[Path] = []
        for item in self.protected_paths:
            try:
                out.append(Path(os.path.realpath(item)))
            except OSError:  # pragma: no cover - defensive
                continue
        return out

    def to_public_dict(self) -> dict[str, Any]:
        """Configuration safe to expose to an authenticated client."""
        return {
            "host": self.host,
            "port": self.port,
            "fs_root": str(self.fs_root_path),
            "max_upload_mb": self.max_upload_mb,
            "max_edit_bytes": self.max_edit_bytes,
            "session_hours": self.session_hours,
            "terminal_idle_minutes": self.terminal_idle_minutes,
            "max_terminal_sessions": self.max_terminal_sessions,
            "panel_name": self.panel_name,
            "tls": bool(self.tls_cert and self.tls_key),
            "behind_proxy": self.behind_proxy,
            "allow_framing": self.allow_framing,
            "protected_paths": [str(p) for p in self.resolved_protected()],
        }


CONFIG_FILE = "config.json"


def load_config(path: Path | None = None) -> Config:
    data_dir = default_data_dir()
    cfg_path = path or (data_dir / CONFIG_FILE)
    values: dict[str, Any] = {}
    if cfg_path.exists():
        try:
            values = json.loads(cfg_path.read_text("utf-8"))
        except (OSError, ValueError) as exc:
            raise RuntimeError(f"Unable to read panel configuration {cfg_path}: {exc}") from exc
        if not isinstance(values, dict):
            raise RuntimeError(f"Panel configuration {cfg_path} is not a JSON object")
    known = {f for f in Config.__dataclass_fields__}  # type: ignore[attr-defined]
    values = {k: v for k, v in values.items() if k in known}

    # Environment overrides (used by tests and by service managers).
    if os.environ.get("PRIME_PORT"):
        values["port"] = int(os.environ["PRIME_PORT"])
    if os.environ.get("PRIME_HOST"):
        values["host"] = os.environ["PRIME_HOST"]
    if _env_bool("PRIME_DEBUG"):
        values["debug"] = True
    if os.environ.get("PRIME_ALLOW_FRAMING"):
        values["allow_framing"] = _env_bool("PRIME_ALLOW_FRAMING")

    cfg = Config(**values)
    if not (1 <= int(cfg.port) <= 65535):
        raise RuntimeError(f"Invalid port in configuration: {cfg.port}")
    if not cfg.install_token:
        cfg.install_token = secrets.token_urlsafe(24)
    return cfg


def save_config(cfg: Config, path: Path | None = None) -> Path:
    data_dir = default_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    cfg_path = path or (data_dir / CONFIG_FILE)
    payload = asdict(cfg)
    payload.pop("install_token", None)
    payload.pop("data_dir", None)
    tmp = cfg_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n", "utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, cfg_path)
    return cfg_path
