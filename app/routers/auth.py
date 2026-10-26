"""Authentication endpoints."""

from __future__ import annotations

import time
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from .. import db
from ..config import Config
from ..security import (
    AuthUser,
    clear_auth_cookies,
    client_ip,
    create_session,
    create_user,
    destroy_session,
    hash_password,
    login_locked,
    new_csrf_token,
    record_attempt,
    require_user,
    resolve_session,
    set_auth_cookies,
    validate_password_policy,
    verify_password,
    check_credentials,
    CSRF_COOKIE,
)

router = APIRouter(prefix="/api/auth")


def _cfg(request: Request) -> Config:
    return request.app.state.cfg


def _origin_ok(request: Request) -> bool:
    origin = request.headers.get("origin")
    if not origin:
        return True
    try:
        parsed = urlsplit(origin)
    except ValueError:
        return False
    return parsed.netloc.lower() == (request.headers.get("host") or "").lower()


def _loopback(ip: str) -> bool:
    return ip in {"127.0.0.1", "::1", "localhost", "-"} or ip.startswith("127.")


class Credentials(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=512)


class SetupBody(Credentials):
    setup_token: str | None = Field(default=None, max_length=200)


class PasswordBody(BaseModel):
    current_password: str = Field(min_length=1, max_length=512)
    new_password: str = Field(min_length=1, max_length=512)


@router.get("/state")
def auth_state(request: Request, response: Response):
    cfg = _cfg(request)
    initialized = db.count_users() > 0
    user = resolve_session(request.cookies.get("pt_session", ""), cfg)
    csrf = request.cookies.get(CSRF_COOKIE, "")
    if user and not csrf:
        csrf = new_csrf_token()
        response.set_cookie(CSRF_COOKIE, csrf, httponly=False, samesite="lax", path="/",
                            secure=request.url.scheme == "https" or bool(cfg.tls_cert))
    return {
        "initialized": initialized,
        "authenticated": user is not None,
        "user": {"username": user.username, "is_admin": user.is_admin} if user else None,
        "csrf_token": csrf,
        "panel_name": cfg.panel_name,
        "setup_allowed": (not initialized),
        "setup_from_loopback": _loopback(client_ip(request, cfg)),
        "version": request.app.state.version,
    }


@router.post("/setup")
def setup(request: Request, body: SetupBody, response: Response):
    cfg = _cfg(request)
    if not _origin_ok(request):
        raise HTTPException(403, "Cross-origin request rejected")
    if db.count_users() > 0:
        raise HTTPException(409, "The panel is already initialised. Sign in or reset the password via CLI.")
    ip = client_ip(request, cfg)
    if not _loopback(ip):
        expected = db.get_setting("setup_token") or ""
        if not expected or not body.setup_token or body.setup_token != expected:
            raise HTTPException(
                403,
                "Initial account creation is restricted to localhost. Run "
                "'bash panel.sh reset-password' on the server, or use the setup token from the installer.",
            )
    try:
        uid = create_user(body.username, body.password)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    db.execute("UPDATE users SET last_login_at = ? WHERE id = ?", (time.time(), uid))
    db.audit(body.username, "user.created", "initial setup", ip)
    db.set_setting("setup_token", "")
    token = create_session(uid, ip, request.headers.get("user-agent", ""), cfg)
    csrf = new_csrf_token()
    set_auth_cookies(response, request, cfg, token, csrf)
    return {"ok": True, "user": {"username": body.username.strip(), "is_admin": True}, "csrf_token": csrf}


@router.post("/login")
def login(request: Request, body: Credentials, response: Response):
    cfg = _cfg(request)
    if not _origin_ok(request):
        raise HTTPException(403, "Cross-origin request rejected")
    ip = client_ip(request, cfg)
    username = body.username.strip()
    locked, unlock_in = login_locked(ip, username, cfg)
    if locked:
        raise HTTPException(
            429, f"Too many failed attempts. Try again in {max(1, unlock_in // 60)} minute(s)."
        )
    user = check_credentials(username, body.password)
    if user is None:
        record_attempt(ip, username, False)
        db.audit(username, "login.failed", "", ip)
        raise HTTPException(401, "Invalid username or password")
    record_attempt(ip, username, True)
    token = create_session(user.id, ip, request.headers.get("user-agent", ""), cfg)
    csrf = new_csrf_token()
    set_auth_cookies(response, request, cfg, token, csrf)
    db.execute("UPDATE users SET last_login_at = ? WHERE id = ?", (time.time(), user.id))
    db.audit(user.username, "login.success", "", ip)
    return {"ok": True, "user": {"username": user.username, "is_admin": user.is_admin}, "csrf_token": csrf}


@router.post("/logout")
def logout(request: Request, response: Response):
    cfg = _cfg(request)
    user = resolve_session(request.cookies.get("pt_session", ""), cfg)
    if user:
        destroy_session(user.session_id)
        db.audit(user.username, "logout", "", client_ip(request, cfg))
    clear_auth_cookies(response)
    return {"ok": True}


@router.get("/me")
def me(user: AuthUser = Depends(require_user)):
    return {"username": user.username, "is_admin": user.is_admin}


@router.post("/password")
def change_password(request: Request, body: PasswordBody, user: AuthUser = Depends(require_user)):
    require_csrf_sync(request)
    row = db.query_one("SELECT password_hash FROM users WHERE id = ?", (user.id,))
    if not row or not verify_password(body.current_password, row["password_hash"]):
        raise HTTPException(403, "Current password is incorrect")
    problem = validate_password_policy(body.new_password, user.username)
    if problem:
        raise HTTPException(400, problem)
    db.execute(
        "UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?",
        (hash_password(body.new_password), time.time(), user.id),
    )
    db.execute("DELETE FROM sessions WHERE user_id = ? AND id != ?", (user.id, user.session_id))
    db.audit(user.username, "password.changed", "", client_ip(request, _cfg(request)))
    return {"ok": True}


def require_csrf_sync(request: Request) -> None:
    import hmac

    if request.method in {"GET", "HEAD", "OPTIONS"}:
        return
    header = request.headers.get("x-csrf-token", "")
    cookie = request.cookies.get(CSRF_COOKIE, "")
    if not header or not cookie or not hmac.compare_digest(header, cookie):
        raise HTTPException(403, "CSRF validation failed")


@router.get("/sessions")
def list_sessions(request: Request, user: AuthUser = Depends(require_user)):
    rows = db.query(
        "SELECT id, created_at, expires_at, last_seen, ip, user_agent FROM sessions "
        "WHERE user_id = ? ORDER BY last_seen DESC",
        (user.id,),
    )
    return {
        "sessions": [
            {
                "id": row["id"],
                "current": row["id"] == user.session_id,
                "created_at": row["created_at"],
                "expires_at": row["expires_at"],
                "last_seen": row["last_seen"],
                "ip": row["ip"],
                "user_agent": row["user_agent"],
            }
            for row in rows
        ]
    }


@router.delete("/sessions/{session_id}")
def revoke_session(
    request: Request, session_id: str, response: Response, user: AuthUser = Depends(require_user)
):
    require_csrf_sync(request)
    if len(session_id) != 64 or any(c not in "0123456789abcdef" for c in session_id):
        raise HTTPException(400, "Invalid session identifier")
    row = db.query_one("SELECT id FROM sessions WHERE id = ? AND user_id = ?", (session_id, user.id))
    if not row:
        raise HTTPException(404, "Session not found")
    destroy_session(session_id)
    db.audit(user.username, "session.revoked", session_id[:12], client_ip(request, _cfg(request)))
    if session_id == user.session_id:
        clear_auth_cookies(response)
    return {"ok": True}
