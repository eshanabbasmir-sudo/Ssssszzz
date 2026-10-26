"""Command-line utilities used by panel.sh (account and setup management).

Usage:
    python3 -m app.cli create-user --username NAME [--password-stdin]
    python3 -m app.cli reset-password --username NAME [--password-stdin]
    python3 -m app.cli list-users
    python3 -m app.cli set-setup-token [--generate]
    python3 -m app.cli check-config
"""

from __future__ import annotations

import argparse
import getpass
import json
import secrets
import sys

from . import db
from .config import load_config
from .security import create_user, hash_password


def _read_password(args: argparse.Namespace) -> str:
    if args.password_stdin:
        password = sys.stdin.readline().rstrip("\n")
        if not password:
            raise SystemExit("No password received on stdin")
        return password
    first = getpass.getpass("Password: ")
    second = getpass.getpass("Repeat password: ")
    if first != second:
        raise SystemExit("Passwords do not match")
    return first


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="prime-terminal", description="PRIME TERMINAL administration")
    sub = parser.add_subparsers(dest="command", required=True)

    p_create = sub.add_parser("create-user", help="create an administrator account")
    p_create.add_argument("--username", required=True)
    p_create.add_argument("--password-stdin", action="store_true")

    p_reset = sub.add_parser("reset-password", help="reset an account password")
    p_reset.add_argument("--username", required=True)
    p_reset.add_argument("--password-stdin", action="store_true")

    sub.add_parser("list-users", help="list panel accounts")

    p_token = sub.add_parser("set-setup-token", help="configure the first-run setup token")
    p_token.add_argument("--generate", action="store_true")
    p_token.add_argument("--token", default="")

    sub.add_parser("check-config", help="validate configuration and print resolved values")

    args = parser.parse_args(argv)
    cfg = load_config()
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    db.init_db(cfg.db_path)

    if args.command == "create-user":
        password = _read_password(args)
        try:
            uid = create_user(args.username, password)
        except ValueError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
        print(f"created user {args.username} (id {uid})")
        return 0

    if args.command == "reset-password":
        row = db.query_one("SELECT id FROM users WHERE username = ? COLLATE NOCASE", (args.username,))
        if not row:
            print(f"error: no such user: {args.username}", file=sys.stderr)
            return 2
        password = _read_password(args)
        try:
            create_user(args.username, password, update_password=True)
        except ValueError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
        print(f"password updated for {args.username}; existing sessions were revoked")
        return 0

    if args.command == "list-users":
        rows = db.query("SELECT id, username, is_admin, created_at, last_login_at FROM users ORDER BY id")
        if not rows:
            print("no users configured")
            return 0
        for row in rows:
            print(
                json.dumps(
                    {
                        "id": row["id"],
                        "username": row["username"],
                        "admin": bool(row["is_admin"]),
                        "created_at": row["created_at"],
                        "last_login_at": row["last_login_at"],
                    }
                )
            )
        return 0

    if args.command == "set-setup-token":
        token = args.token or (secrets.token_urlsafe(24) if args.generate else "")
        db.set_setting("setup_token", token)
        if token:
            print(token)
        else:
            print("setup token cleared")
        return 0

    if args.command == "check-config":
        print(
            json.dumps(
                {
                    "data_dir": str(cfg.data_dir),
                    "port": cfg.port,
                    "host": cfg.host,
                    "fs_root": str(cfg.fs_root_path),
                    "shell": cfg.shell,
                    "db": str(cfg.db_path),
                    "users": db.count_users(),
                    "log_dir": str(cfg.log_dir),
                },
                indent=2,
            )
        )
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
