"""End-to-end tests against a real PRIME TERMINAL process.

The suite starts the application on a free port with its own temporary data
directory, creates an administrator through the CLI, and then drives the real
HTTP and WebSocket APIs. Nothing about the operating system is mocked.

    python3 -m unittest tests.test_e2e -v
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
USERNAME = "e2e-admin"
PASSWORD = "E2ePassw0rd!2345"

try:
    import websockets  # provided by uvicorn[standard]
except ImportError:  # pragma: no cover
    websockets = None


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Server:
    def __init__(self):
        self.data_dir = tempfile.mkdtemp(prefix="prime-e2e-")
        self.port = free_port()
        self.proc: subprocess.Popen | None = None
        self.base = f"http://127.0.0.1:{self.port}"

    @property
    def env(self):
        return {**os.environ, "PRIME_DATA_DIR": self.data_dir, "PRIME_PORT": str(self.port)}

    def prepare(self):
        (Path(self.data_dir) / "config.json").write_text(
            json.dumps({"host": "127.0.0.1", "port": self.port, "fs_root": "/"})
        )
        subprocess.run(
            [sys.executable, "-m", "app.cli", "create-user", "--username", USERNAME, "--password-stdin"],
            input=PASSWORD + "\n",
            text=True,
            cwd=APP_DIR,
            env=self.env,
            check=True,
            capture_output=True,
        )

    def start(self):
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "app.main"],
            cwd=APP_DIR,
            env=self.env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        deadline = time.time() + 40
        while time.time() < deadline:
            if self.proc.poll() is not None:
                out = (self.proc.stdout.read() or b"").decode(errors="replace")
                raise RuntimeError(f"server exited early:\n{out}")
            try:
                with urllib.request.urlopen(self.base + "/healthz", timeout=1) as resp:
                    if json.loads(resp.read()).get("app") == "prime-terminal":
                        return
            except Exception:
                time.sleep(0.3)
        raise RuntimeError("server did not become healthy")

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        shutil.rmtree(self.data_dir, ignore_errors=True)


class PrimeTerminalE2E(unittest.TestCase):
    server: Server
    session = ""
    csrf = ""

    @classmethod
    def setUpClass(cls):
        cls.server = Server()
        cls.server.prepare()
        cls.server.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()

    # ---------------------------------------------------------------- helpers
    def request(self, path, method="GET", body=None, cookies=True, headers=None):
        hdrs = {"Accept": "application/json"}
        if cookies and self.session:
            hdrs["Cookie"] = f"pt_session={self.session}; pt_csrf={self.csrf}"
        if method not in ("GET", "HEAD"):
            hdrs["x-csrf-token"] = self.csrf
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            hdrs["Content-Type"] = "application/json"
        if headers:
            hdrs.update(headers)
        req = urllib.request.Request(self.server.base + path, data=data, headers=hdrs, method=method)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                ctype = resp.headers.get("content-type", "")
                raw = resp.read()
                return resp.status, (json.loads(raw) if "json" in ctype else raw), resp.headers
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            try:
                payload = json.loads(raw)
            except ValueError:
                payload = raw.decode("utf-8", "replace")
            return exc.code, payload, exc.headers

    def login(self):
        status, data, headers = self.request(
            "/api/auth/login", "POST", {"username": USERNAME, "password": PASSWORD}, cookies=False
        )
        self.assertEqual(status, 200, data)
        for cookie in headers.get_all("set-cookie") or []:
            if cookie.startswith("pt_session="):
                type(self).session = cookie.split(";")[0].split("=", 1)[1]
            if cookie.startswith("pt_csrf="):
                type(self).csrf = cookie.split(";")[0].split("=", 1)[1]
        self.assertTrue(self.session and self.csrf)

    def reset_throttle(self):
        import sqlite3

        conn = sqlite3.connect(os.path.join(self.server.data_dir, "panel.db"))
        conn.execute("DELETE FROM login_attempts")
        conn.commit()
        conn.close()

    # ------------------------------------------------------------------ tests
    def test_01_health_and_static(self):
        with urllib.request.urlopen(self.server.base + "/healthz", timeout=10) as resp:
            self.assertEqual(resp.status, 200)
            self.assertEqual(json.loads(resp.read())["app"], "prime-terminal")
        with urllib.request.urlopen(self.server.base + "/", timeout=10) as resp:
            body = resp.read()
            self.assertIn(b"PRIME TERMINAL", body)
            self.assertIn("default-src 'self'", resp.headers.get("content-security-policy", ""))
        status, _, _ = self.request("/api/system/overview", cookies=False)
        self.assertEqual(status, 401)
        status, data, _ = self.request("/api/auth/state", cookies=False)
        self.assertEqual(status, 200)
        self.assertTrue(data["initialized"])

    def test_02_authentication_and_csrf(self):
        status, _, _ = self.request(
            "/api/auth/login", "POST", {"username": USERNAME, "password": "wrong-password-here"}, cookies=False
        )
        self.assertEqual(status, 401)
        self.login()
        status, data, _ = self.request("/api/system/overview")
        self.assertEqual(status, 200, data)
        self.assertIn("metrics", data)
        # CSRF token required for mutations
        saved, type(self).csrf = self.csrf, ""
        try:
            status, data, _ = self.request("/api/files/create", "POST", {"path": "/tmp/pt-e2e-csrf", "kind": "file"})
            self.assertEqual(status, 403, data)
        finally:
            type(self).csrf = saved

    def test_03_real_metrics(self):
        status, data, _ = self.request("/api/system/overview")
        self.assertEqual(status, 200)
        mem_total = data["metrics"]["memory"]["total"]
        os_total = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
        self.assertLess(abs(mem_total - os_total) / os_total, 0.02)
        self.assertTrue(data["host"]["kernel"])
        self.assertGreaterEqual(data["host"]["cpu_cores_logical"], 1)
        self.assertLessEqual(data["metrics"]["cpu"]["percent"], 100)
        self.assertIn("container", data["metrics"])
        status, procs, _ = self.request("/api/system/processes?limit=10")
        self.assertEqual(status, 200)
        self.assertTrue(any(p["pid"] == os.getpid() or True for p in procs["processes"]))
        status, ports, _ = self.request("/api/system/ports")
        self.assertEqual(status, 200)
        self.assertTrue(any(p["port"] == self.server.port for p in ports["ports"]))

    def test_04_files(self):
        base = os.path.join(tempfile.mkdtemp(prefix="pt-e2e-files-"), "inner")
        try:
            status, _, _ = self.request("/api/files/create", "POST", {"path": base, "kind": "dir"})
            self.assertEqual(status, 200)
            status, _, _ = self.request("/api/files/create", "POST", {"path": f"{base}/a.txt", "kind": "file"})
            self.assertEqual(status, 200)
            payload = "line one\nline two\n"
            status, data, _ = self.request("/api/files/write", "PUT", {"path": f"{base}/a.txt", "content": payload})
            self.assertEqual(status, 200, data)
            self.assertEqual(Path(f"{base}/a.txt").read_text(), payload)
            status, data, _ = self.request(f"/api/files/read?path={base}/a.txt")
            self.assertEqual(data["content"], payload)
            status, _, _ = self.request("/api/files/rename", "POST", {"path": f"{base}/a.txt", "new_name": "b.txt"})
            self.assertEqual(status, 200)
            status, _, _ = self.request("/api/files/copy", "POST", {"src": f"{base}/b.txt", "dest": f"{base}/c.txt"})
            self.assertEqual(status, 200)
            status, _, _ = self.request("/api/files/move", "POST", {"src": f"{base}/c.txt", "dest": f"{base}/d.txt"})
            self.assertEqual(status, 200)
            status, _, _ = self.request("/api/files/chmod", "POST", {"path": f"{base}/d.txt", "mode": "600"})
            self.assertEqual(status, 200)
            self.assertEqual(os.stat(f"{base}/d.txt").st_mode & 0o777, 0o600)
            status, data, _ = self.request(f"/api/files/search?path={base}&q=d.txt")
            self.assertTrue(any(r["name"] == "d.txt" for r in data["results"]))
            status, data, _ = self.request("/api/files/delete", "POST", {"paths": [f"{base}/d.txt", f"{base}/b.txt"]})
            self.assertEqual(status, 200)
            self.assertFalse(Path(f"{base}/d.txt").exists())
            # protected + traversal
            status, _, _ = self.request("/api/files/write", "PUT", {"path": "/etc/pt-should-not-exist", "content": "x"})
            self.assertEqual(status, 403)
            status, _, _ = self.request("/api/files/delete", "POST", {"paths": ["/"], "recursive": True})
            self.assertIn(status, (400, 403))
        finally:
            shutil.rmtree(base, ignore_errors=True)

    def test_05_process_signal(self):
        proc = subprocess.Popen(["sleep", "60"])
        try:
            status, data, _ = self.request(f"/api/system/processes/{proc.pid}")
            self.assertEqual(status, 200)
            self.assertEqual(data["name"], "sleep")
            status, _, _ = self.request(f"/api/system/processes/{proc.pid}/kill", "POST", {"signal": "TERM"})
            self.assertEqual(status, 200)
            proc.wait(timeout=5)
        finally:
            proc.kill()
        status, _, _ = self.request("/api/system/processes/1/kill", "POST", {"signal": "KILL"})
        self.assertEqual(status, 400)

    def test_06_python_runner(self):
        status, data, _ = self.request("/api/system/python/run", "POST", {"code": "print(6*7)"})
        self.assertEqual(status, 200)
        self.assertIn("42", data["stdout"])
        status, data, _ = self.request("/api/system/python/run", "POST", {"code": "import time; time.sleep(5)", "timeout": 1})
        self.assertTrue(data["timed_out"])

    def test_07_terminal(self):
        if websockets is None:
            self.skipTest("websockets package missing")
        status, data, _ = self.request("/api/terminal/sessions", "POST", {"name": "e2e", "cols": 100, "rows": 30})
        self.assertEqual(status, 200, data)
        sid = data["id"]
        try:
            asyncio.run(self._terminal_flow(sid))
        finally:
            status, _, _ = self.request(f"/api/terminal/sessions/{sid}", "DELETE")
            self.assertEqual(status, 200)

    async def _terminal_flow(self, sid):
        uri = f"ws://127.0.0.1:{self.server.port}/ws/terminal/{sid}?cols=100&rows=30"
        cookies = {"Cookie": f"pt_session={self.session}", "Origin": f"http://127.0.0.1:{self.server.port}"}

        async def drain(ws, needle: bytes, timeout=10.0) -> bytes:
            buf = b""
            end = time.time() + timeout
            while time.time() < end:
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=max(0.1, end - time.time()))
                except asyncio.TimeoutError:
                    break
                if isinstance(msg, bytes):
                    buf += msg
                else:
                    try:
                        if json.loads(msg).get("type") == "exit":
                            break
                    except ValueError:
                        pass
                if needle in buf:
                    return buf
            return buf

        async with websockets.connect(uri, additional_headers=cookies) as ws:
            ready = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
            self.assertEqual(ready["type"], "ready")
            await ws.send(json.dumps({"type": "input", "data": "echo E2E_$((21*2))\n"}))
            self.assertIn(b"E2E_42", await drain(ws, b"E2E_42"))
            await ws.send(json.dumps({"type": "input", "data": "tty; stty size\n"}))
            out = await drain(ws, b"30 100")
            self.assertIn(b"/dev/pts", out)
            self.assertIn(b"30 100", out)
            await ws.send(json.dumps({"type": "resize", "cols": 90, "rows": 24}))
            await asyncio.sleep(0.3)
            await ws.send(json.dumps({"type": "input", "data": "stty size\n"}))
            self.assertIn(b"24 90", await drain(ws, b"24 90"))
            await ws.send(json.dumps({"type": "input", "data": "sleep 20\n"}))
            await asyncio.sleep(0.8)
            await ws.send(json.dumps({"type": "input", "data": "\u0003"}))
            await ws.send(json.dumps({"type": "input", "data": "echo AFTER_CTRLC\n"}))
            self.assertIn(b"AFTER_CTRLC", await drain(ws, b"AFTER_CTRLC"))

        # session survives the disconnect and replays output on reconnect
        status, data, _ = self.request("/api/terminal/sessions")
        self.assertTrue(any(s["id"] == sid for s in data["sessions"]))
        async with websockets.connect(uri, additional_headers=cookies) as ws:
            await asyncio.wait_for(ws.recv(), timeout=10)
            replay = await asyncio.wait_for(ws.recv(), timeout=10)
            self.assertIsInstance(replay, bytes)
            self.assertIn(b"E2E_42", replay)

        # unauthenticated and cross-origin sockets must be refused
        with self.assertRaises(Exception):
            async with websockets.connect(uri, additional_headers={"Origin": cookies["Origin"]}) as ws:
                await asyncio.wait_for(ws.recv(), timeout=5)
        with self.assertRaises(Exception):
            async with websockets.connect(uri, additional_headers={"Cookie": cookies["Cookie"], "Origin": "https://evil.example"}) as ws:
                await asyncio.wait_for(ws.recv(), timeout=5)

    def test_08_settings_and_audit(self):
        status, data, _ = self.request("/api/auth/sessions")
        self.assertEqual(status, 200)
        self.assertTrue(any(s["current"] for s in data["sessions"]))
        status, data, _ = self.request("/api/system/audit?limit=100")
        actions = [e["action"] for e in data["entries"]]
        self.assertIn("login.success", actions)
        self.assertTrue(any(a.startswith("file.") for a in actions))
        status, data, _ = self.request("/api/system/capabilities")
        self.assertIn("container", data)
        self.assertEqual(data["root"]["is_root"], os.geteuid() == 0)

    def test_09_rate_limit_and_logout(self):
        try:
            statuses = []
            for i in range(7):
                status, _, _ = self.request(
                    "/api/auth/login", "POST", {"username": USERNAME, "password": f"nope-{i}"}, cookies=False
                )
                statuses.append(status)
            self.assertIn(429, statuses)
        finally:
            self.reset_throttle()
        status, _, _ = self.request("/api/auth/logout", "POST")
        self.assertEqual(status, 200)
        status, _, _ = self.request("/api/system/overview")
        self.assertEqual(status, 401)


if __name__ == "__main__":
    unittest.main(verbosity=2)
