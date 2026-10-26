"""Unit tests for security primitives, configuration and path confinement."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException

from app import system_info
from app.config import Config, load_config, save_config
from app.routers.files import _mutation_blocked, resolve
from app.security import (
    hash_password,
    validate_password_policy,
    verify_password,
)
from app.terminal import decode_client_message


class PasswordTests(unittest.TestCase):
    def test_hash_and_verify(self):
        hashed = hash_password("correct horse battery staple")
        self.assertTrue(hashed.startswith("scrypt$"))
        self.assertTrue(verify_password("correct horse battery staple", hashed))
        self.assertFalse(verify_password("wrong password", hashed))

    def test_hashes_are_salted(self):
        self.assertNotEqual(hash_password("same-password-123"), hash_password("same-password-123"))

    def test_policy(self):
        self.assertIsNotNone(validate_password_policy("short", "admin"))
        self.assertIsNone(validate_password_policy("long-enough-pass", "admin"))
        self.assertIsNotNone(validate_password_policy("admin", "admin"))

    def test_malformed_hash_rejected(self):
        self.assertFalse(verify_password("x", "not-a-hash"))
        self.assertFalse(verify_password("x", "scrypt$bad"))


class ConfigTests(unittest.TestCase):
    def test_defaults(self):
        cfg = Config()
        self.assertEqual(cfg.port, 8080)
        self.assertTrue(Path(cfg.shell).exists())
        self.assertIn("/proc", [str(p) for p in cfg.resolved_protected()])

    def test_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["PRIME_DATA_DIR"] = tmp
            try:
                cfg = Config(port=9099, fs_root="/tmp", max_upload_mb=10, install_token="secret")
                path = save_config(cfg)
                self.assertTrue(path.exists())
                self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
                loaded = load_config(path)
                self.assertEqual(loaded.port, 9099)
                self.assertEqual(loaded.fs_root, "/tmp")
                self.assertEqual(loaded.max_upload_mb, 10)
                # reset token must never be serialised
                self.assertNotIn("install_token", path.read_text())
                public = loaded.to_public_dict()
                self.assertNotIn("install_token", public)
            finally:
                os.environ.pop("PRIME_DATA_DIR", None)

    def test_invalid_port_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["PRIME_DATA_DIR"] = tmp
            try:
                path = Path(tmp) / "config.json"
                path.write_text('{"port": 99999}')
                with self.assertRaises(RuntimeError):
                    load_config(path)
            finally:
                os.environ.pop("PRIME_DATA_DIR", None)


class PathConfinementTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(os.path.realpath(self.tmp.name))
        (self.root / "inside").mkdir()
        (self.root / "inside" / "file.txt").write_text("hello")
        self.outside = Path(tempfile.mkdtemp()) / "outside.txt"
        self.outside.write_text("secret")
        self.cfg = Config(fs_root=str(self.root))
        self.cfg.data_dir  # ensure property works

    def tearDown(self):
        self.tmp.cleanup()
        self.outside.unlink(missing_ok=True)

    def test_inside_allowed(self):
        resolved = resolve(self.cfg, str(self.root / "inside" / "file.txt"))
        self.assertEqual(resolved, self.root / "inside" / "file.txt")

    def test_parent_relative_allowed(self):
        resolved = resolve(self.cfg, "inside/file.txt")
        self.assertTrue(str(resolved).startswith(str(self.root)))

    def test_traversal_rejected(self):
        with self.assertRaises(HTTPException) as ctx:
            resolve(self.cfg, str(self.root) + "/../../etc/passwd")
        self.assertEqual(ctx.exception.status_code, 403)

    def test_absolute_outside_rejected(self):
        with self.assertRaises(HTTPException) as ctx:
            resolve(self.cfg, str(self.outside))
        self.assertEqual(ctx.exception.status_code, 403)

    def test_symlink_escape_rejected(self):
        link = self.root / "inside" / "escape"
        link.symlink_to(self.outside)
        with self.assertRaises(HTTPException):
            resolve(self.cfg, str(link))

    def test_null_byte_rejected(self):
        with self.assertRaises(HTTPException):
            resolve(self.cfg, "/tmp/\x00bad")

    def test_protected_paths_blocked(self):
        cfg = Config(fs_root="/")
        self.assertIsNotNone(_mutation_blocked(cfg, Path("/proc/self/environ")))
        self.assertIsNotNone(_mutation_blocked(cfg, Path("/")))
        self.assertIsNone(_mutation_blocked(cfg, Path("/tmp/some-file")))

    def test_data_dir_protected(self):
        cfg = Config(fs_root="/")
        cfg_data = Path(os.path.realpath(cfg.data_dir))
        self.assertIsNotNone(_mutation_blocked(cfg, cfg_data / "panel.db"))


class SystemInfoTests(unittest.TestCase):
    def test_host_info_is_real(self):
        info = system_info.host_info()
        self.assertTrue(info["kernel"])
        self.assertTrue(info["hostname"])
        self.assertGreaterEqual(info["cpu_cores_logical"], 1)
        self.assertIsInstance(info["container"], dict)

    def test_metrics_are_plausible(self):
        m = system_info.metrics(Config())
        self.assertGreater(m["memory"]["total"], 0)
        self.assertLessEqual(m["memory"]["used"], m["memory"]["total"])
        self.assertGreaterEqual(m["cpu"]["percent"], 0)
        self.assertLessEqual(m["cpu"]["percent"], 100)

    def test_hostname_validation(self):
        self.assertEqual(system_info.validate_host("example.com"), "example.com")
        for bad in ("", "bad host", "-leading", "a;rm -rf /", "$(id)"):
            with self.assertRaises(ValueError):
                system_info.validate_host(bad)

    def test_ssh_key_validation(self):
        good = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl user@host"
        self.assertTrue(system_info.SSH_KEY_RE.match(good))
        for bad in ("not a key", "ssh-ed25519", "rm -rf / #"):
            self.assertFalse(bool(system_info.SSH_KEY_RE.match(bad)))

    def test_listening_ports_shape(self):
        data = system_info.listening_ports()
        self.assertIn("ports", data)
        self.assertIsInstance(data["ports"], list)


class TerminalTests(unittest.TestCase):
    def test_client_message_decoding(self):
        self.assertEqual(decode_client_message('{"type":"input","data":"ls\\n"}'), ("input", {"type": "input", "data": "ls\n"}))
        self.assertEqual(decode_client_message("plain text"), ("input", "plain text"))
        self.assertEqual(decode_client_message("not json {"), ("input", "not json {"))

    def test_shell_argv(self):
        from app.terminal import _login_shell_argv

        self.assertEqual(_login_shell_argv(Config(terminal_shell="/bin/bash")), ["/bin/bash", "-l"])
        self.assertEqual(_login_shell_argv(Config(terminal_shell="/bin/sh")), ["/bin/sh"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
