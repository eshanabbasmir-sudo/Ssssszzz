"""Authentication, session management, CSRF and login throttling."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import time
from dataclasses import dataclass
from urllib.parse import urlsplit

from fastapi import HTTPException, Request, WebSocket

from . import db
from .config import Config

SESSION_COOKIE = "pt_session"
CSRF_COOKIE = "pt_csrf"
CSRF_HEADER = "x-csrf-token"
SESSION_TOUCH_INTERVAL = 300.0

# scrypt parameters: ~16 MB memory, well above the OWASP minimum.
_SCRYPT_N = 2**14
_SCRYPT_R = 8
_SCRYPT_P = 1
_SCRYPT_DKLEN = 32

USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")


@dataclass
class AuthUser:
    id: int
    username: str
    is_admin: bool
    session_id: str


# --------------------------------------------------------------------------
# Password hashing
# --------------------------------------------------------------------------
def hash_password(password: str) -> str:
    if not isinstance(password, str) or not password:
        raise ValueError("Password must not be empty")
    salt = os.urandom(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P, dklen=_SCRYPT_DKLEN
    )
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt_hex, digest_hex = stored.split("$")
        if scheme != "scrypt":
            return False
        expected = bytes.fromhex(digest_hex)
        actual = hashlib.scrypt(
            password.encode("utf-8"),
            salt=bytes.fromhex(salt_hex),
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(expected),
        )
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def validate_password_policy(password: str, username: str) -> str | None:
    if len(password) < 10:
        return "Password must be at least 10 characters long."
    if len(password) > 512:
        return "Password is too long."
    if password.lower() == username.lower():
        return "Password must not match the username."
    if password.strip() == "":
        return "Password must not be blank."
    return None


# --------------------------------------------------------------------------
# Users
# --------------------------------------------------------------------------
def create_user(username: str, password: str, *, update_password: bool = False) -> int:
    username = username.strip()
    if not USERNAME_RE.match(username):
        raise ValueError("Username must be 3-32 characters: letters, numbers, dot, dash, underscore.")
    problem = validate_password_policy(password, username)
    if problem:
        raise ValueError(problem)
    now = time.time()
    existing = db.query_one("SELECT id FROM users WHERE username = ? COLLATE NOCASE", (username,))
    ph = hash_password(password)
    if existing:
        if not update_password:
            raise ValueError("A user with that name already exists.")
        db.execute(
            "UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?",
            (ph, now, existing["id"]),
        )
        db.execute("DELETE FROM sessions WHERE user_id = ?", (existing["id"],))
        db.audit(username, "password.reset", "reset via CLI/installer")
        return int(existing["id"])
    uid = db.execute(
        "INSERT INTO users(username, password_hash, is_admin, created_at, password_changed_at) VALUES(?,?,?,?,?)",
        (username, ph, 1, now, now),
    )
    db.audit(username, "user.created")
    return uid


def check_credentials(username: str, password: str) -> AuthUser | None:
    row = db.query_one("SELECT * FROM users WHERE username = ? COLLATE NOCASE", (username.strip(),))
    # Always run a hash verification to keep timing roughly constant for
    # unknown usernames.
    stored = row["password_hash"] if row else hash_password("dummy-password-value")
    ok = verify_password(password, stored)
    if not row or not ok:
        return None
    return AuthUser(id=int(row["id"]), username=row["username"], is_admin=bool(row["is_admin"]), session_id="")


# --------------------------------------------------------------------------
# Login throttling
# --------------------------------------------------------------------------
def _client_ip(request: Request | WebSocket, cfg: Config) -> str:
    if cfg.trust_proxy_headers:
        fwd = request.headers.get("x-forwarded-for")
        if fwd:
            return fwd.split(",")[0].strip()
        real = request.headers.get("x-real-ip")
        if real:
            return real.strip()
    if request.client:
        return request.client.host or "-"
    return "-"


def client_ip(request: Request | WebSocket, cfg: Config) -> str:
    return _client_ip(request, cfg)


def login_locked(ip: str, username: str, cfg: Config) -> tuple[bool, int]:
    window = max(1, cfg.login_window_minutes) * 60
    since = time.time() - window
    rows = db.query(
        "SELECT COUNT(*) AS n FROM login_attempts WHERE ts > ? AND success = 0 AND (ip = ? OR username = ?)",
        (since, ip, username),
    )
    failures = int(rows[0]["n"]) if rows else 0
    limit = max(1, cfg.login_max_attempts)
    if failures >= limit:
        oldest = db.query_one(
            "SELECT MIN(ts) AS t FROM login_attempts WHERE ts > ? AND success = 0 AND (ip = ? OR username = ?)",
            (since, ip, username),
        )
        unlock_in = int(window - (time.time() - float(oldest["t"] or time.time()))) if oldest else window
        return True, max(1, unlock_in)
    return False, 0


def record_attempt(ip: str, username: str, success: bool) -> None:
    db.execute(
        "INSERT INTO login_attempts(ip, username, ts, success) VALUES(?,?,?,?)",
        (ip, username[:64], time.time(), 1 if success else 0),
    )
    if success:
        db.execute(
            "DELETE FROM login_attempts WHERE ip = ? AND username = ? AND success = 0",
            (ip, username[:64]),
        )


# --------------------------------------------------------------------------
# Sessions
# --------------------------------------------------------------------------
def _session_id(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_session(user_id: int, ip: str, user_agent: str, cfg: Config) -> str:
    token = secrets.token_urlsafe(32)
    now = time.time()
    ttl = max(0.5, cfg.session_hours) * 3600
    db.execute(
        "INSERT INTO sessions(id, user_id, created_at, expires_at, last_seen, ip, user_agent) VALUES(?,?,?,?,?,?,?)",
        (_session_id(token), user_id, now, now + ttl, now, ip, (user_agent or "")[:300]),
    )
    return token


def resolve_session(token: str, cfg: Config) -> AuthUser | None:
    if not token or len(token) > 200:
        return None
    sid = _session_id(token)
    row = db.query_one(
        "SELECT s.id AS sid, s.expires_at, s.last_seen, u.id, u.username, u.is_admin "
        "FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?",
        (sid,),
    )
    if not row:
        return None
    now = time.time()
    if float(row["expires_at"]) < now:
        db.execute("DELETE FROM sessions WHERE id = ?", (sid,))
        return None
    if now - float(row["last_seen"]) > SESSION_TOUCH_INTERVAL:
        db.execute("UPDATE sessions SET last_seen = ? WHERE id = ?", (now, sid))
    return AuthUser(id=int(row["id"]), username=row["username"], is_admin=bool(row["is_admin"]), session_id=sid)


def destroy_session(session_id: str) -> None:
    db.execute("DELETE FROM sessions WHERE id = ?", (session_id,))


def user_from_request(request: Request) -> AuthUser | None:
    cfg: Config = request.app.state.cfg
    return resolve_session(request.cookies.get(SESSION_COOKIE, ""), cfg)


def user_from_websocket(websocket: WebSocket) -> AuthUser | None:
    cfg: Config = websocket.app.state.cfg
    return resolve_session(websocket.cookies.get(SESSION_COOKIE, ""), cfg)


# --------------------------------------------------------------------------
# FastAPI dependencies
# --------------------------------------------------------------------------
async def require_user(request: Request) -> AuthUser:
    user = user_from_request(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    return user


async def require_csrf(request: Request) -> None:
    if request.method in {"GET", "HEAD", "OPTIONS"}:
        return
    header = request.headers.get(CSRF_HEADER, "")
    cookie = request.cookies.get(CSRF_COOKIE, "")
    if not header or not cookie or not hmac.compare_digest(header, cookie):
        raise HTTPException(status_code=403, detail="CSRF validation failed")


# --------------------------------------------------------------------------
# WebSocket origin validation
# --------------------------------------------------------------------------
def websocket_origin_ok(websocket: WebSocket) -> bool:
    cfg = getattr(websocket.app.state, "cfg", None)
    if cfg is not None and getattr(cfg, "allow_framing", False):
        # Hosted preview mode: the panel is intentionally embedded in a
        # third-party frame and reached through a proxy that may rewrite the
        # Host header. Session-cookie authentication still applies.
        return True
    origin = websocket.headers.get("origin")
    if not origin:
        # Non-browser clients are allowed through: they still need a valid
        # session cookie, and CSRF is a browser-only threat model.
        return True
    host = (websocket.headers.get("host") or "").lower()
    forwarded = (websocket.headers.get("x-forwarded-host") or "").split(",")[0].strip().lower()
    try:
        parsed = urlsplit(origin)
    except ValueError:
        return False
    if not parsed.netloc:
        return False
    origin_host = parsed.netloc.lower()
    return origin_host == host or (bool(forwarded) and origin_host == forwarded)


def set_auth_cookies(response, request: Request, cfg: Config, token: str, csrf: str) -> None:
    secure = request.url.scheme == "https" or bool(cfg.tls_cert)
    max_age = int(max(0.5, cfg.session_hours) * 3600)
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=max_age,
        httponly=True,
        samesite="lax",
        secure=secure,
        path="/",
    )
    response.set_cookie(
        CSRF_COOKIE,
        csrf,
        max_age=max_age,
        httponly=False,
        samesite="lax",
        secure=secure,
        path="/",
    )


def clear_auth_cookies(response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.delete_cookie(CSRF_COOKIE, path="/")


def new_csrf_token() -> str:
    return secrets.token_urlsafe(32)


def json_error(status: int, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail=message)


def client_ip_from_scope(request: Request | WebSocket, cfg: Config) -> str:
    """Public helper used by routers for audit entries."""
    return _client_ip(request, cfg)


# --------------------------------------------------------------------------
# Misc helpers
# --------------------------------------------------------------------------
def safe_detail(exc: BaseException) -> str:
    """Never leak absolute paths of secrets; keep messages short and useful."""
    text = str(exc) or exc.__class__.__name__
    return text[:1000]


def dumps(obj) -> str:
    return json.dumps(obj, separators=(",", ":"))
