"""Real filesystem API with path-traversal protection."""

from __future__ import annotations

import grp
import os
import pwd
import secrets
import shutil
import stat as statmod
import time
import zipfile
from pathlib import Path
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ..config import Config
from ..security import AuthUser, client_ip, require_csrf, require_user
from .. import db

router = APIRouter(prefix="/api/files", dependencies=[Depends(require_user), Depends(require_csrf)])

TEXT_SNIFF = 8192


def _cfg(request: Request) -> Config:
    return request.app.state.cfg


def _within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def resolve(cfg: Config, raw: str | None, *, must_exist: bool = True) -> Path:
    root = cfg.fs_root_path
    value = (raw or "").strip() or str(root)
    if "\x00" in value:
        raise HTTPException(400, "Invalid path")
    if not value.startswith("/"):
        value = str(root / value)
    real = Path(os.path.realpath(value))
    if real != root and not _within(real, root):
        raise HTTPException(403, "Path is outside the permitted filesystem root")
    if must_exist and not real.exists():
        raise HTTPException(404, f"Path does not exist: {real}")
    return real


def _mutation_blocked(cfg: Config, path: Path) -> str | None:
    root = cfg.fs_root_path
    if path == root:
        return "The filesystem root cannot be modified or deleted."
    protected = cfg.resolved_protected()
    try:
        protected.append(Path(os.path.realpath(cfg.data_dir)))
    except OSError:
        pass
    for item in protected:
        if path == item or _within(path, item):
            return f"{path} is a protected system path."
    if str(path) in {"/etc", "/var", "/home", "/root", "/tmp"} and path.is_dir():
        return f"{path} is a protected system path."
    return None


def _owner(uid: int) -> str:
    try:
        return pwd.getpwuid(uid).pw_name
    except KeyError:
        return str(uid)


def _group(gid: int) -> str:
    try:
        return grp.getgrgid(gid).gr_name
    except KeyError:
        return str(gid)


def _mode_string(mode: int) -> str:
    return statmod.filemode(mode)


def _entry(path: Path, cfg: Config) -> dict[str, Any]:
    try:
        st = path.lstat()
    except OSError as exc:
        return {"name": path.name, "path": str(path), "error": str(exc), "is_dir": False}
    is_symlink = path.is_symlink()
    target = ""
    if is_symlink:
        try:
            target = os.readlink(path)
        except OSError:
            target = "?"
    try:
        is_dir = path.is_dir()
    except OSError:
        is_dir = False
    return {
        "name": path.name or str(path),
        "path": str(path),
        "is_dir": is_dir,
        "is_symlink": is_symlink,
        "link_target": target,
        "size": st.st_size,
        "mode": oct(st.st_mode & 0o7777),
        "mode_string": _mode_string(st.st_mode),
        "uid": st.st_uid,
        "gid": st.st_gid,
        "owner": _owner(st.st_uid),
        "group": _group(st.st_gid),
        "mtime": st.st_mtime,
        "atime": st.st_atime,
        "readable": os.access(path, os.R_OK),
        "writable": os.access(path, os.W_OK),
        "hidden": path.name.startswith("."),
    }


def _log(request: Request, user: AuthUser, action: str, detail: str) -> None:
    db.audit(user.username, action, detail, client_ip(request, _cfg(request)))


# --------------------------------------------------------------------------
# Models
# --------------------------------------------------------------------------
class PathBody(BaseModel):
    path: str


class CreateBody(BaseModel):
    path: str
    kind: str = Field(default="file", pattern="^(file|dir)$")


class RenameBody(BaseModel):
    path: str
    new_name: str


class CopyMoveBody(BaseModel):
    src: str
    dest: str
    overwrite: bool = False


class DeleteBody(BaseModel):
    paths: list[str]
    recursive: bool = False


class WriteBody(BaseModel):
    path: str
    content: str


class ChmodBody(BaseModel):
    path: str
    mode: str = Field(pattern="^[0-7]{3,4}$")


class ChownBody(BaseModel):
    path: str
    uid: int | str
    gid: int | str


# --------------------------------------------------------------------------
# Read endpoints
# --------------------------------------------------------------------------
@router.get("")
@router.get("/")
def roots(request: Request):
    cfg = _cfg(request)
    root = cfg.fs_root_path
    home = Path(os.path.expanduser("~"))
    return {
        "root": str(root),
        "home": str(home) if _within(Path(os.path.realpath(home)), root) else str(root),
        "cwd": str(root),
        "protected": [str(p) for p in cfg.resolved_protected()],
        "separator": os.sep,
    }


@router.get("/list")
def list_dir(
    request: Request,
    path: str = Query(default=""),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=400, ge=1, le=2000),
    show_hidden: bool = Query(default=True),
    query: str = Query(default="", max_length=200),
):
    cfg = _cfg(request)
    target = resolve(cfg, path)
    if not target.is_dir():
        raise HTTPException(400, "Path is not a directory")
    try:
        entries = list(os.scandir(target))
    except PermissionError:
        raise HTTPException(403, f"Permission denied reading {target}")
    except OSError as exc:
        raise HTTPException(400, f"Cannot list {target}: {exc}")
    entries.sort(key=lambda e: (not _safe_isdir(e), e.name.lower()))
    if not show_hidden:
        entries = [e for e in entries if not e.name.startswith(".")]
    if query:
        needle = query.lower()
        entries = [e for e in entries if needle in e.name.lower()]
    total = len(entries)
    page = entries[offset : offset + limit]
    items = [_entry(Path(e.path), cfg) for e in page]
    parent = target.parent if target != cfg.fs_root_path else None
    usage = None
    try:
        vfs = os.statvfs(target)
        total_b = vfs.f_blocks * vfs.f_frsize
        free_b = vfs.f_bavail * vfs.f_frsize
        usage = {
            "total": total_b,
            "free": free_b,
            "used": total_b - free_b,
            "percent": round((total_b - free_b) / total_b * 100, 1) if total_b else 0.0,
        }
    except OSError:
        pass
    return {
        "path": str(target),
        "parent": str(parent) if parent else None,
        "root": str(cfg.fs_root_path),
        "total": total,
        "offset": offset,
        "limit": limit,
        "has_more": offset + len(items) < total,
        "entries": items,
        "usage": usage,
    }


def _safe_isdir(entry: os.DirEntry) -> bool:
    try:
        return entry.is_dir(follow_symlinks=False)
    except OSError:
        return False


@router.get("/stat")
def stat_path(request: Request, path: str = Query(...)):
    cfg = _cfg(request)
    target = resolve(cfg, path)
    data = _entry(target, cfg)
    if target.is_dir():
        try:
            data["children"] = sum(1 for _ in os.scandir(target))
        except OSError:
            data["children"] = None
    return data


@router.get("/read")
def read_file(request: Request, path: str = Query(...)):
    cfg = _cfg(request)
    target = resolve(cfg, path)
    if target.is_dir():
        raise HTTPException(400, "Path is a directory")
    try:
        st = target.stat()
    except OSError as exc:
        raise HTTPException(400, str(exc))
    if st.st_size > cfg.max_edit_bytes:
        return {
            "path": str(target),
            "is_binary": False,
            "too_large": True,
            "size": st.st_size,
            "max_edit_bytes": cfg.max_edit_bytes,
            "content": "",
        }
    try:
        with open(target, "rb") as fh:
            raw = fh.read(min(TEXT_SNIFF, st.st_size))
            if b"\x00" in raw:
                return {"path": str(target), "is_binary": True, "size": st.st_size, "content": ""}
            fh.seek(0)
            data = fh.read()
    except PermissionError:
        raise HTTPException(403, f"Permission denied reading {target}")
    except OSError as exc:
        raise HTTPException(400, f"Cannot read {target}: {exc}")
    try:
        text = data.decode("utf-8")
        encoding = "utf-8"
    except UnicodeDecodeError:
        text = data.decode("latin-1")
        encoding = "latin-1"
    return {
        "path": str(target),
        "is_binary": False,
        "too_large": False,
        "size": st.st_size,
        "encoding": encoding,
        "content": text,
        "mode": oct(st.st_mode & 0o7777),
        "mtime": st.st_mtime,
        "writable": os.access(target, os.W_OK),
    }


@router.get("/download")
def download(request: Request, path: str = Query(...)):
    cfg = _cfg(request)
    target = resolve(cfg, path)
    if target.is_dir():
        raise HTTPException(400, "Cannot download a directory; create an archive instead")
    if not os.access(target, os.R_OK):
        raise HTTPException(403, "Permission denied reading that file")
    return FileResponse(str(target), filename=target.name, headers={"Cache-Control": "no-store"})


@router.get("/search")
def search(
    request: Request,
    path: str = Query(default=""),
    q: str = Query(..., min_length=1, max_length=200),
    limit: int = Query(default=200, ge=1, le=1000),
    max_depth: int = Query(default=6, ge=1, le=16),
):
    cfg = _cfg(request)
    base = resolve(cfg, path)
    if not base.is_dir():
        raise HTTPException(400, "Search root is not a directory")
    needle = q.lower()
    results: list[dict[str, Any]] = []
    deadline = time.time() + 6.0
    truncated = False
    visited = 0
    for current, dirs, files in os.walk(base, followlinks=False):
        if time.time() > deadline:
            truncated = True
            break
        depth = len(Path(current).relative_to(base).parts)
        if depth >= max_depth:
            dirs[:] = []
        dirs[:] = [d for d in dirs if not d.startswith(".") or needle.startswith(".")]
        for name in dirs + files:
            visited += 1
            if needle in name.lower():
                entry_path = Path(current) / name
                results.append(_entry(entry_path, cfg))
                if len(results) >= limit:
                    truncated = True
                    break
        if len(results) >= limit:
            truncated = True
            break
        if visited > 200_000:
            truncated = True
            break
    results.sort(key=lambda r: (not r.get("is_dir"), r.get("name", "").lower()))
    return {"results": results, "truncated": truncated, "scanned": visited, "query": q, "root": str(base)}


# --------------------------------------------------------------------------
# Mutations
# --------------------------------------------------------------------------
@router.post("/create")
def create(request: Request, body: CreateBody, user: AuthUser = Depends(require_user)):
    cfg = _cfg(request)
    raw = (body.path or "").rstrip("/")
    if not raw:
        raise HTTPException(400, "A file name is required")
    name = Path(raw).name
    if not name or name in {".", ".."}:
        raise HTTPException(400, "Invalid file name")
    parent_raw = raw[: -len(name)] or "/"
    parent = resolve(cfg, parent_raw)
    if not parent.is_dir():
        raise HTTPException(400, f"Parent is not a directory: {parent}")
    target = parent / name
    if target.exists():
        raise HTTPException(409, f"{target} already exists")
    blocked = _mutation_blocked(cfg, target)
    if blocked:
        raise HTTPException(403, blocked)
    try:
        if body.kind == "dir":
            target.mkdir(mode=0o755)
        else:
            target.touch(mode=0o644, exist_ok=False)
    except PermissionError:
        raise HTTPException(403, f"Permission denied creating {target}")
    except OSError as exc:
        raise HTTPException(400, f"Cannot create {target}: {exc}")
    _log(request, user, "file.create", f"{body.kind} {target}")
    return {"ok": True, "path": str(target), "entry": _entry(target, cfg)}


@router.put("/write")
def write(request: Request, body: WriteBody, user: AuthUser = Depends(require_user)):
    cfg = _cfg(request)
    target = resolve(cfg, body.path, must_exist=False)
    if target.is_dir():
        raise HTTPException(400, "Path is a directory")
    blocked = _mutation_blocked(cfg, target)
    if blocked:
        raise HTTPException(403, blocked)
    payload = body.content.encode("utf-8")
    if len(payload) > cfg.max_edit_bytes:
        raise HTTPException(413, f"File exceeds the {cfg.max_edit_bytes // 1024} KB edit limit")
    if not target.parent.exists():
        raise HTTPException(400, f"Directory does not exist: {target.parent}")
    tmp = target.with_name(f".{target.name}.pt-{secrets.token_hex(4)}")
    try:
        with open(tmp, "wb") as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())
        if target.exists():
            st = target.stat()
            os.chmod(tmp, st.st_mode & 0o7777)
            try:
                os.chown(tmp, st.st_uid, st.st_gid)
            except PermissionError:
                pass
        else:
            os.chmod(tmp, 0o644)
        os.replace(tmp, target)
    except PermissionError:
        tmp.unlink(missing_ok=True)
        raise HTTPException(403, f"Permission denied writing {target}")
    except OSError as exc:
        tmp.unlink(missing_ok=True)
        raise HTTPException(400, f"Cannot write {target}: {exc}")
    _log(request, user, "file.write", f"{target} ({len(payload)} bytes)")
    return {"ok": True, "path": str(target), "size": len(payload), "entry": _entry(target, cfg)}


@router.post("/rename")
def rename(request: Request, body: RenameBody, user: AuthUser = Depends(require_user)):
    cfg = _cfg(request)
    src = resolve(cfg, body.path)
    name = body.new_name.strip()
    if not name or name in {".", ".."} or "/" in name or "\x00" in name:
        raise HTTPException(400, "Invalid file name")
    dest = src.parent / name
    blocked = _mutation_blocked(cfg, src) or _mutation_blocked(cfg, dest)
    if blocked:
        raise HTTPException(403, blocked)
    if dest.exists():
        raise HTTPException(409, f"{dest} already exists")
    try:
        src.rename(dest)
    except PermissionError:
        raise HTTPException(403, "Permission denied")
    except OSError as exc:
        raise HTTPException(400, f"Cannot rename: {exc}")
    _log(request, user, "file.rename", f"{src} -> {dest}")
    return {"ok": True, "path": str(dest)}


@router.post("/copy")
def copy(request: Request, body: CopyMoveBody, user: AuthUser = Depends(require_user)):
    cfg = _cfg(request)
    src = resolve(cfg, body.src)
    dest = resolve(cfg, body.dest, must_exist=False)
    blocked = _mutation_blocked(cfg, dest)
    if blocked:
        raise HTTPException(403, blocked)
    if src == dest:
        raise HTTPException(400, "Source and destination are the same")
    if src.is_dir() and _within(dest, src):
        raise HTTPException(400, "Cannot copy a directory into itself")
    if dest.exists() and not body.overwrite:
        raise HTTPException(409, f"{dest} already exists")
    try:
        if src.is_dir():
            shutil.copytree(src, dest, symlinks=True, dirs_exist_ok=body.overwrite)
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)
    except PermissionError:
        raise HTTPException(403, "Permission denied")
    except (OSError, shutil.Error) as exc:
        raise HTTPException(400, f"Cannot copy: {exc}")
    _log(request, user, "file.copy", f"{src} -> {dest}")
    return {"ok": True, "path": str(dest)}


@router.post("/move")
def move(request: Request, body: CopyMoveBody, user: AuthUser = Depends(require_user)):
    cfg = _cfg(request)
    src = resolve(cfg, body.src)
    dest = resolve(cfg, body.dest, must_exist=False)
    blocked = _mutation_blocked(cfg, src) or _mutation_blocked(cfg, dest)
    if blocked:
        raise HTTPException(403, blocked)
    if src == dest:
        raise HTTPException(400, "Source and destination are the same")
    if src.is_dir() and _within(dest, src):
        raise HTTPException(400, "Cannot move a directory into itself")
    if dest.exists():
        if not body.overwrite:
            raise HTTPException(409, f"{dest} already exists")
        if dest.is_dir() and not src.is_dir():
            raise HTTPException(400, "Cannot overwrite a directory with a file")
    try:
        if dest.exists() and not dest.is_dir():
            dest.unlink()
        shutil.move(str(src), str(dest))
    except PermissionError:
        raise HTTPException(403, "Permission denied")
    except (OSError, shutil.Error) as exc:
        raise HTTPException(400, f"Cannot move: {exc}")
    _log(request, user, "file.move", f"{src} -> {dest}")
    return {"ok": True, "path": str(dest)}


@router.post("/delete")
def delete(request: Request, body: DeleteBody, user: AuthUser = Depends(require_user)):
    cfg = _cfg(request)
    if not body.paths:
        raise HTTPException(400, "No paths supplied")
    if len(body.paths) > 500:
        raise HTTPException(400, "Too many paths in a single request")
    deleted: list[str] = []
    errors: list[dict[str, str]] = []
    for raw in body.paths:
        try:
            target = resolve(cfg, raw)
            blocked = _mutation_blocked(cfg, target)
            if blocked:
                raise PermissionError(blocked)
            if target.is_dir():
                if not body.recursive:
                    raise IsADirectoryError(f"{target} is a directory (recursive delete not confirmed)")
                shutil.rmtree(target)
            else:
                target.unlink()
            deleted.append(str(target))
        except HTTPException as exc:
            errors.append({"path": raw, "error": str(exc.detail)})
        except PermissionError as exc:
            errors.append({"path": raw, "error": str(exc)})
        except OSError as exc:
            errors.append({"path": raw, "error": f"{exc.strerror or exc}"})
    if deleted:
        _log(request, user, "file.delete", ", ".join(deleted[:50]))
    if errors and not deleted:
        raise HTTPException(400, errors[0]["error"])
    return {"ok": not errors, "deleted": deleted, "errors": errors}


@router.post("/chmod")
def chmod(request: Request, body: ChmodBody, user: AuthUser = Depends(require_user)):
    cfg = _cfg(request)
    target = resolve(cfg, body.path)
    blocked = _mutation_blocked(cfg, target)
    if blocked:
        raise HTTPException(403, blocked)
    mode = int(body.mode, 8)
    try:
        os.chmod(target, mode)
    except PermissionError:
        raise HTTPException(403, "Permission denied changing permissions")
    except OSError as exc:
        raise HTTPException(400, f"Cannot chmod: {exc}")
    _log(request, user, "file.chmod", f"{target} -> {body.mode}")
    return {"ok": True, "entry": _entry(target, cfg)}


@router.post("/chown")
def chown(request: Request, body: ChownBody, user: AuthUser = Depends(require_user)):
    cfg = _cfg(request)
    target = resolve(cfg, body.path)
    blocked = _mutation_blocked(cfg, target)
    if blocked:
        raise HTTPException(403, blocked)
    if os.geteuid() != 0:
        raise HTTPException(403, "Changing ownership requires the panel to run as root")

    def _id(value: int | str, is_group: bool) -> int:
        if isinstance(value, int):
            return value
        if str(value).isdigit():
            return int(value)
        try:
            return (grp.getgrnam(value).gr_gid if is_group else pwd.getpwnam(value).pw_uid)
        except KeyError:
            raise HTTPException(400, f"Unknown {'group' if is_group else 'user'}: {value}")

    uid = _id(body.uid, False)
    gid = _id(body.gid, True)
    try:
        os.chown(target, uid, gid)
    except PermissionError:
        raise HTTPException(403, "Permission denied changing ownership")
    except OSError as exc:
        raise HTTPException(400, f"Cannot chown: {exc}")
    _log(request, user, "file.chown", f"{target} -> {uid}:{gid}")
    return {"ok": True, "entry": _entry(target, cfg)}


@router.post("/upload")
async def upload(
    request: Request,
    file: UploadFile = File(...),
    dest: str = Form(default=""),
    overwrite: bool = Form(default=False),
    user: AuthUser = Depends(require_user),
):
    cfg = _cfg(request)
    directory = resolve(cfg, dest)
    if not directory.is_dir():
        raise HTTPException(400, "Upload destination is not a directory")
    if not os.access(directory, os.W_OK):
        raise HTTPException(403, f"No write permission on {directory}")
    raw_name = (file.filename or "upload.bin").replace("\\", "/").split("/")[-1].strip()
    raw_name = raw_name.replace("\x00", "")
    if not raw_name or raw_name in {".", ".."}:
        raise HTTPException(400, "Invalid upload filename")
    if len(raw_name) > 200:
        raise HTTPException(400, "Upload filename is too long")
    target = directory / raw_name
    blocked = _mutation_blocked(cfg, target)
    if blocked:
        raise HTTPException(403, blocked)
    if target.exists() and not overwrite:
        raise HTTPException(409, f"{target.name} already exists in this folder")
    max_bytes = cfg.max_upload_mb * 1024 * 1024
    tmp = directory / f".pt-upload-{secrets.token_hex(6)}"
    written = 0
    try:
        with open(tmp, "wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > max_bytes:
                    raise HTTPException(413, f"Upload exceeds the {cfg.max_upload_mb} MB limit")
                out.write(chunk)
            out.flush()
            os.fsync(out.fileno())
        os.chmod(tmp, 0o644)
        os.replace(tmp, target)
    except HTTPException:
        tmp.unlink(missing_ok=True)
        raise
    except PermissionError:
        tmp.unlink(missing_ok=True)
        raise HTTPException(403, "Permission denied writing upload")
    except OSError as exc:
        tmp.unlink(missing_ok=True)
        raise HTTPException(400, f"Upload failed: {exc}")
    finally:
        await file.close()
    _log(request, user, "file.upload", f"{target} ({written} bytes)")
    return {"ok": True, "path": str(target), "size": written, "entry": _entry(target, cfg)}


@router.get("/archive")
def archive(
    request: Request,
    background: BackgroundTasks,
    paths: list[str] = Query(...),
    name: str = Query(default="download"),
):
    cfg = _cfg(request)
    if not paths or len(paths) > 100:
        raise HTTPException(400, "Select between 1 and 100 paths")
    targets = [resolve(cfg, p) for p in paths]
    tmp_dir = Path(os.path.realpath(cfg.data_dir)) / "tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    safe_name = "".join(c for c in name if c.isalnum() or c in "-_ ").strip() or "download"
    out_path = tmp_dir / f"{safe_name}-{secrets.token_hex(4)}.zip"
    try:
        with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED, compresslevel=5) as zf:
            for target in targets:
                if target.is_dir():
                    base_parent = target.parent
                    for root, _dirs, files in os.walk(target):
                        for fname in files:
                            full = Path(root) / fname
                            if full.is_symlink():
                                continue
                            try:
                                zf.write(full, full.relative_to(base_parent))
                            except (OSError, ValueError):
                                continue
                else:
                    zf.write(target, target.name)
    except OSError as exc:
        out_path.unlink(missing_ok=True)
        raise HTTPException(400, f"Cannot create archive: {exc}")
    if out_path.stat().st_size > 2 * 1024**3:
        out_path.unlink(missing_ok=True)
        raise HTTPException(413, "Archive would exceed 2 GB")
    background.add_task(lambda: out_path.unlink(missing_ok=True))
    return FileResponse(str(out_path), filename=f"{safe_name}.zip", background=background)
