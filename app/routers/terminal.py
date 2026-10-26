"""Terminal session management API + the PTY WebSocket."""

from __future__ import annotations

import asyncio
import json
import time

from fastapi import APIRouter, Depends, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from .. import db
from ..config import Config
from ..security import (
    AuthUser,
    client_ip,
    require_csrf,
    require_user,
    user_from_websocket,
    websocket_origin_ok,
)
from ..terminal import TerminalError, decode_client_message, session_for_user

router = APIRouter()


def _cfg(request: Request) -> Config:
    return request.app.state.cfg


class NewSessionBody(BaseModel):
    name: str = Field(default="shell", max_length=40)
    cols: int = Field(default=100, ge=10, le=1000)
    rows: int = Field(default=30, ge=3, le=500)


@router.get("/api/terminal/sessions", dependencies=[Depends(require_user)])
def list_sessions(request: Request, user: AuthUser = Depends(require_user)):
    manager = request.app.state.terminals
    return {
        "sessions": [s.info() for s in manager.user_sessions(user.id, user.is_admin)],
        "limits": {
            "max_sessions": request.app.state.cfg.max_terminal_sessions,
            "idle_minutes": request.app.state.cfg.terminal_idle_minutes,
        },
    }


@router.post("/api/terminal/sessions", dependencies=[Depends(require_user), Depends(require_csrf)])
def create_session(request: Request, body: NewSessionBody, user: AuthUser = Depends(require_user)):
    manager = request.app.state.terminals
    try:
        session = manager.create(user.id, user.username, body.name, body.cols, body.rows)
    except TerminalError as exc:
        raise HTTPException(400, str(exc))
    except Exception as exc:
        raise HTTPException(500, f"Unable to start terminal: {exc}")
    db.audit(user.username, "terminal.open", f"{session.id[:8]} shell={session.shell}", client_ip(request, _cfg(request)))
    return session.info()


@router.delete("/api/terminal/sessions/{session_id}", dependencies=[Depends(require_user), Depends(require_csrf)])
def close_session(request: Request, session_id: str, user: AuthUser = Depends(require_user)):
    manager = request.app.state.terminals
    if not session_id.isalnum() or len(session_id) != 32:
        raise HTTPException(400, "Invalid session id")
    try:
        closed = manager.close(session_id, user.id, user.is_admin)
    except PermissionError as exc:
        raise HTTPException(403, str(exc))
    if not closed:
        raise HTTPException(404, "Session not found")
    db.audit(user.username, "terminal.close", session_id[:8], client_ip(request, _cfg(request)))
    return {"ok": True}


@router.websocket("/ws/terminal/{session_id}")
async def terminal_ws(websocket: WebSocket, session_id: str, cols: int = Query(default=0), rows: int = Query(default=0)):
    user = user_from_websocket(websocket)
    if user is None:
        await websocket.close(code=4401, reason="Authentication required")
        return
    if not websocket_origin_ok(websocket):
        await websocket.close(code=4403, reason="Cross-origin WebSocket rejected")
        return
    manager = websocket.app.state.terminals
    try:
        session = session_for_user(manager, session_id, user.id, user.is_admin)
    except TerminalError as exc:
        await websocket.close(code=4404, reason=str(exc)[:120])
        return
    await websocket.accept()
    if cols and rows:
        session.resize(cols, rows)
    queue: asyncio.Queue = asyncio.Queue(maxsize=512)
    session.clients.add(queue)
    session.last_activity = time.time()
    try:
        await websocket.send_text(
            json.dumps(
                {
                    "type": "ready",
                    "id": session.id,
                    "shell": session.shell,
                    "cols": session.cols,
                    "rows": session.rows,
                    "pid": session.proc.pid if session.proc else None,
                    "buffer_bytes": len(session.buffer),
                }
            )
        )
        if session.buffer:
            await websocket.send_bytes(bytes(session.buffer))

        async def pump_output() -> None:
            while True:
                item = await queue.get()
                if isinstance(item, dict):
                    await websocket.send_text(json.dumps(item))
                    if item.get("type") == "exit":
                        return
                else:
                    await websocket.send_bytes(item)

        async def pump_input() -> None:
            while True:
                message = await websocket.receive()
                if message.get("type") == "websocket.disconnect":
                    return
                text = message.get("text")
                if text is None:
                    data = message.get("bytes") or b""
                    session.write(data)
                    continue
                kind, payload = decode_client_message(text)
                if kind == "input":
                    data = payload.get("data", "") if isinstance(payload, dict) else payload
                    if data:
                        session.write(data)
                elif kind == "resize":
                    try:
                        session.resize(int(payload.get("cols", session.cols)), int(payload.get("rows", session.rows)))
                    except (TypeError, ValueError):
                        continue
                elif kind == "ping":
                    await websocket.send_text(json.dumps({"type": "pong", "ts": time.time()}))
                elif kind == "signal" and payload.get("name") in {"INT", "TERM", "HUP"}:
                    import signal as sigmod

                    session.write(bytes([3]) if payload["name"] == "INT" else b"")
                    if payload["name"] != "INT":
                        session.kill(getattr(sigmod, f"SIG{payload['name']}"))

        output_task = asyncio.create_task(pump_output())
        input_task = asyncio.create_task(pump_input())
        done, pending = await asyncio.wait({output_task, input_task}, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        for task in done:
            exc = task.exception()
            if exc and not isinstance(exc, (WebSocketDisconnect, asyncio.CancelledError)):
                pass  # connection problems are normal; the session stays alive
    except (WebSocketDisconnect, RuntimeError, asyncio.CancelledError):
        pass
    finally:
        session.clients.discard(queue)
        session.last_activity = time.time()
        try:
            await websocket.close()
        except (RuntimeError, WebSocketDisconnect):
            pass
