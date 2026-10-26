"""Real pseudo-terminal sessions over WebSocket.

Each session owns a genuine PTY with a forked shell, so interactive programs
(dash, top, vim, nano, python REPLs ...) behave exactly as they do over SSH.
Output is buffered in memory so a browser can reconnect and replay recent
scrollback.
"""

from __future__ import annotations

import asyncio
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import termios
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from . import db
from .config import Config

READ_CHUNK = 65536


def _login_shell_argv(cfg: Config) -> list[str]:
    shell = cfg.shell
    name = os.path.basename(shell)
    if name in {"bash", "zsh", "fish"}:
        return [shell, "-l"]
    if name in {"sh", "dash", "ash", "ksh"}:
        return [shell]
    return [shell]


def _child_env(cfg: Config) -> dict[str, str]:
    env = {
        "TERM": "xterm-256color",
        "COLORTERM": "truecolor",
        "SHELL": cfg.shell,
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "LC_ALL": os.environ.get("LC_ALL", ""),
        "PATH": os.environ.get("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"),
        "HOME": os.path.expanduser("~"),
        "USER": os.environ.get("USER", ""),
        "LOGNAME": os.environ.get("LOGNAME", os.environ.get("USER", "")),
        "PRIME_TERMINAL": "1",
        "TERM_PROGRAM": "PRIME-TERMINAL",
        "COLUMNS": "80",
        "LINES": "24",
    }
    for key in ("SSH_AUTH_SOCK", "XDG_RUNTIME_DIR", "DISPLAY", "TZ"):
        if key in os.environ:
            env[key] = os.environ[key]
    if not env["LC_ALL"]:
        env.pop("LC_ALL")
    if not env.get("PS1"):
        env["PS1"] = "\\[\\e[36m\\]\\u@\\h\\[\\e[0m\\]:\\[\\e[34m\\]\\w\\[\\e[0m\\]$ "
    return {k: v for k, v in env.items() if v}


class TerminalError(RuntimeError):
    pass


@dataclass
class TerminalSession:
    id: str
    user_id: int
    username: str
    name: str
    cfg: Config
    cols: int = 100
    rows: int = 30
    shell: str = ""
    created_at: float = field(default_factory=time.time)
    last_activity: float = field(default_factory=time.time)
    proc: subprocess.Popen | None = None
    master_fd: int = -1
    buffer: bytearray = field(default_factory=bytearray)
    clients: set[asyncio.Queue] = field(default_factory=set)
    closed: bool = False
    exit_code: int | None = None

    @property
    def max_buffer(self) -> int:
        return max(64, self.cfg.terminal_scrollback_kb) * 1024

    # -- lifecycle ------------------------------------------------------
    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        master_fd, slave_fd = pty.openpty()
        self._set_winsize(slave_fd, self.cols, self.rows)
        cwd = os.path.expanduser("~")
        if not os.path.isdir(cwd) or not os.access(cwd, os.X_OK):
            cwd = "/"
        argv = _login_shell_argv(self.cfg)
        self.shell = " ".join(argv)

        def _preexec() -> None:  # runs in the child between fork and exec
            os.setsid()
            try:
                fcntl.ioctl(0, termios.TIOCSCTTY, 0)
            except OSError:
                pass

        try:
            self.proc = subprocess.Popen(
                argv,
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                preexec_fn=_preexec,
                close_fds=True,
                cwd=cwd,
                env=_child_env(self.cfg),
            )
        except OSError as exc:
            os.close(master_fd)
            os.close(slave_fd)
            raise TerminalError(f"Unable to start shell '{argv[0]}': {exc}") from exc
        finally:
            try:
                os.close(slave_fd)
            except OSError:
                pass
        self.master_fd = master_fd
        os.set_blocking(self.master_fd, False)
        loop.add_reader(self.master_fd, self._on_readable)
        self.loop = loop

    def _set_winsize(self, fd: int, cols: int, rows: int) -> None:
        cols = max(1, min(int(cols), 1000))
        rows = max(1, min(int(rows), 500))
        self.cols, self.rows = cols, rows
        try:
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        except OSError:
            pass

    def resize(self, cols: int, rows: int) -> None:
        if self.closed or self.master_fd < 0:
            return
        self._set_winsize(self.master_fd, cols, rows)
        if self.proc and self.proc.poll() is None:
            try:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGWINCH)
            except OSError:
                try:
                    self.proc.send_signal(signal.SIGWINCH)
                except OSError:
                    pass

    # -- I/O ------------------------------------------------------------
    def _on_readable(self) -> None:
        if self.closed:
            return
        try:
            data = os.read(self.master_fd, READ_CHUNK)
        except BlockingIOError:
            return
        except OSError:
            data = b""
        if not data:
            self._mark_closed()
            return
        self.last_activity = time.time()
        self.buffer.extend(data)
        overflow = len(self.buffer) - self.max_buffer
        if overflow > 0:
            del self.buffer[:overflow]
        for queue in list(self.clients):
            try:
                queue.put_nowait(data)
            except asyncio.QueueFull:
                pass

    def _mark_closed(self) -> None:
        if self.closed:
            return
        self.closed = True
        try:
            self.loop.remove_reader(self.master_fd)
        except (OSError, ValueError, AttributeError):
            pass
        try:
            os.close(self.master_fd)
        except OSError:
            pass
        self.master_fd = -1
        code: int | None = None
        if self.proc is not None:
            try:
                code = self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                code = None
        self.exit_code = code
        message = {"type": "exit", "code": code}
        for queue in list(self.clients):
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                pass

    def write(self, data: str | bytes) -> None:
        if self.closed or self.master_fd < 0:
            return
        payload = data.encode("utf-8", "replace") if isinstance(data, str) else data
        if not payload:
            return
        self.last_activity = time.time()
        offset = 0
        while offset < len(payload):
            try:
                offset += os.write(self.master_fd, payload[offset:])
            except BlockingIOError:
                time.sleep(0.005)
            except OSError:
                self._mark_closed()
                return

    def kill(self, sig: int = signal.SIGHUP) -> None:
        if self.proc is not None and self.proc.poll() is None:
            try:
                os.killpg(os.getpgid(self.proc.pid), sig)
            except OSError:
                try:
                    self.proc.kill()
                except OSError:
                    pass
        self._mark_closed()

    def info(self, *, include_buffer: bool = False) -> dict[str, Any]:
        live = self.proc.poll() is None if self.proc else False
        return {
            "id": self.id,
            "name": self.name,
            "user": self.username,
            "shell": self.shell,
            "pid": self.proc.pid if self.proc else None,
            "alive": live and not self.closed,
            "clients": len(self.clients),
            "cols": self.cols,
            "rows": self.rows,
            "created_at": self.created_at,
            "last_activity": self.last_activity,
            "exit_code": self.exit_code,
            "buffer_bytes": len(self.buffer),
        }


class TerminalManager:
    """Owns all PTY sessions for the panel process."""

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.sessions: dict[str, TerminalSession] = {}
        self._reaper: asyncio.Task | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        if self._reaper is None or self._reaper.done():
            self._reaper = self._loop.create_task(self._reap_loop())

    async def _reap_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(20)
                idle_limit = max(1, self.cfg.terminal_idle_minutes) * 60
                now = time.time()
                for session in list(self.sessions.values()):
                    if session.closed:
                        self.sessions.pop(session.id, None)
                        continue
                    if session.clients:
                        continue
                    if now - session.last_activity > idle_limit:
                        session.kill()
                        self.sessions.pop(session.id, None)
                        db.audit(session.username, "terminal.reap", f"idle {session.id[:8]}")
            except asyncio.CancelledError:
                raise
            except Exception:  # pragma: no cover - defensive
                continue

    def user_sessions(self, user_id: int, is_admin: bool) -> list[TerminalSession]:
        return sorted(
            (s for s in self.sessions.values() if is_admin or s.user_id == user_id),
            key=lambda s: s.created_at,
        )

    def create(self, user_id: int, username: str, name: str, cols: int, rows: int) -> TerminalSession:
        if self._loop is None:
            raise TerminalError("Terminal subsystem is not initialised")
        live = [s for s in self.sessions.values() if s.user_id == user_id and not s.closed]
        if len(live) >= max(1, self.cfg.max_terminal_sessions):
            raise TerminalError(
                f"Session limit reached ({self.cfg.max_terminal_sessions}). Close a session and try again."
            )
        session = TerminalSession(
            id=uuid.uuid4().hex,
            user_id=user_id,
            username=username,
            name=(name or "shell")[:40],
            cfg=self.cfg,
            cols=cols,
            rows=rows,
        )
        session.start(self._loop)
        self.sessions[session.id] = session
        return session

    def get(self, session_id: str) -> TerminalSession | None:
        return self.sessions.get(session_id)

    def close(self, session_id: str, user_id: int, is_admin: bool) -> bool:
        session = self.sessions.get(session_id)
        if not session:
            return False
        if not is_admin and session.user_id != user_id:
            raise PermissionError("You can only close your own sessions")
        session.kill()
        self.sessions.pop(session_id, None)
        return True

    def shutdown(self) -> None:
        for session in list(self.sessions.values()):
            session.kill()
        self.sessions.clear()
        if self._reaper is not None:
            self._reaper.cancel()
            self._reaper = None


def session_for_user(manager: TerminalManager, session_id: str, user_id: int, is_admin: bool) -> TerminalSession:
    session = manager.get(session_id)
    if session is None:
        raise TerminalError("Session not found or already closed")
    if not is_admin and session.user_id != user_id:
        raise TerminalError("Session belongs to another user")
    return session


def decode_client_message(raw: str) -> tuple[str, Any]:
    try:
        payload = json.loads(raw)
    except ValueError:
        return "input", raw
    if not isinstance(payload, dict):
        return "input", raw
    kind = payload.get("type", "input")
    return kind, payload
