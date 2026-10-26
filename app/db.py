"""SQLite persistence layer (users, sessions, audit trail, login throttling)."""

from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Iterable

_conn: sqlite3.Connection | None = None
_lock = threading.RLock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    username           TEXT NOT NULL UNIQUE,
    password_hash      TEXT NOT NULL,
    is_admin           INTEGER NOT NULL DEFAULT 1,
    created_at         REAL NOT NULL,
    password_changed_at REAL NOT NULL,
    last_login_at      REAL
);

CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   REAL NOT NULL,
    expires_at   REAL NOT NULL,
    last_seen    REAL NOT NULL,
    ip           TEXT,
    user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS login_attempts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ip         TEXT,
    username   TEXT,
    ts         REAL NOT NULL,
    success    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_ts ON login_attempts(ts);

CREATE TABLE IF NOT EXISTS audit (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       REAL NOT NULL,
    username TEXT,
    action   TEXT NOT NULL,
    detail   TEXT,
    ip       TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def init_db(db_path: Path) -> None:
    global _conn
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with _lock:
        if _conn is not None:
            _conn.close()
        _conn = sqlite3.connect(str(db_path), check_same_thread=False, timeout=15)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute("PRAGMA foreign_keys=ON")
        _conn.execute("PRAGMA busy_timeout=8000")
        _conn.executescript(SCHEMA)
        _conn.commit()


def conn() -> sqlite3.Connection:
    if _conn is None:  # pragma: no cover - defensive
        raise RuntimeError("Database not initialised")
    return _conn


def execute(sql: str, params: Iterable[Any] = ()) -> int:
    with _lock:
        cur = conn().execute(sql, tuple(params))
        conn().commit()
        return cur.lastrowid or 0


def execute_many(sql: str, rows: Iterable[Iterable[Any]]) -> None:
    with _lock:
        conn().executemany(sql, [tuple(r) for r in rows])
        conn().commit()


def query(sql: str, params: Iterable[Any] = ()) -> list[sqlite3.Row]:
    with _lock:
        return list(conn().execute(sql, tuple(params)).fetchall())


def query_one(sql: str, params: Iterable[Any] = ()) -> sqlite3.Row | None:
    with _lock:
        return conn().execute(sql, tuple(params)).fetchone()


def get_setting(key: str, default: str | None = None) -> str | None:
    row = query_one("SELECT value FROM settings WHERE key = ?", (key,))
    return row["value"] if row else default


def set_setting(key: str, value: str) -> None:
    execute(
        "INSERT INTO settings(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )


def count_users() -> int:
    row = query_one("SELECT COUNT(*) AS n FROM users")
    return int(row["n"]) if row else 0


def audit(username: str | None, action: str, detail: str = "", ip: str = "") -> None:
    try:
        execute(
            "INSERT INTO audit(ts, username, action, detail, ip) VALUES(?,?,?,?,?)",
            (time.time(), username or "-", action[:80], detail[:2000], ip[:64]),
        )
    except sqlite3.Error:  # auditing must never break the request path
        pass


def prune(settings_retention_days: int = 90) -> None:
    now = time.time()
    execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
    execute("DELETE FROM login_attempts WHERE ts < ?", (now - 24 * 3600,))
    cutoff = now - max(1, settings_retention_days) * 86400
    execute("DELETE FROM audit WHERE ts < ?", (cutoff,))
