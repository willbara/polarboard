"""Small test harness: starts a Polarboard server on a throwaway data folder,
drives it with Playwright, and counts passes and failures.

Only the standard library and Playwright are needed (pip install playwright;
playwright install chromium).
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Server:
    """A Polarboard server with its own temporary data folder."""

    def __init__(self, env=None):
        self.dir = Path(tempfile.mkdtemp(prefix="polarboard-test-"))
        self.port = free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        self.vault = self.dir / "vault"
        env = {**os.environ, "POLARBOARD_DATA": str(self.dir), "POLARBOARD_PORT": str(self.port),
               "POLARBOARD_EXAMPLES": str(ROOT / "tests" / "seed"),  # a small, fixed starter set the tests rely on
               "POLARBOARD_HOST": "127.0.0.1", **(env or {})}
        self.log = open(self.dir / "server.log", "w")
        self.proc = subprocess.Popen([sys.executable, str(ROOT / "server.py")], env=env, stdout=self.log, stderr=subprocess.STDOUT)
        for _ in range(100):
            try:
                urllib.request.urlopen(self.url + "/healthz", timeout=1)
                return
            except OSError:
                time.sleep(0.05)
        raise RuntimeError("server did not start")

    def api(self, method, path, body=None, headers=None, raw=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        h = {"X-Polarboard": "1", **({"Content-Type": "application/json"} if raw is None else {}), **(headers or {})}
        req = urllib.request.Request(self.url + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return {"_status": e.code, **json.loads(e.read() or b"{}")}

    def status(self, method, path, headers=None):
        req = urllib.request.Request(self.url + path, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status
        except urllib.error.HTTPError as e:
            return e.code

    def errors(self):
        self.log.flush()
        return [l for l in (self.dir / "server.log").read_text().splitlines() if not l.startswith("Polarboard ")]

    def stop(self):
        self.proc.terminate()
        try:
            self.proc.wait(5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self.log.close()
        shutil.rmtree(self.dir, ignore_errors=True)


class Suite:
    """Counts checks. Test modules call t.ok(condition, description)."""

    def __init__(self, name, browser, shots):
        self.name, self.browser, self.shots = name, browser, shots
        self.passed, self.failed, self.page_errors = 0, [], []
        self.server = None

    def ok(self, cond, msg):
        if cond:
            self.passed += 1
            print(f"  \033[32mPASS\033[0m {msg}", flush=True)
        else:
            self.failed.append(msg)
            print(f"  \033[31mFAIL\033[0m {msg}", flush=True)
        return cond

    def start(self, env=None):
        self.server = Server(env)
        return self.server

    def page(self, settings=None, viewport=(1366, 860), theme="dark", context=None, mobile=False, ignore=()):
        """A page with test-friendly settings: grain still, Harper off unless asked for."""
        ctx = context or self.browser.new_context(
            viewport={"width": viewport[0], "height": viewport[1]}, color_scheme=theme, accept_downloads=True,
            **({"device_scale_factor": 2, "is_mobile": True, "has_touch": True} if mobile else {}))
        pg = ctx.new_page()
        base = {"grainAnim": False, "spellEngine": "off", **(settings or {})}
        pg.add_init_script(f"localStorage.getItem('pb:settings') || localStorage.setItem('pb:settings', {json.dumps(json.dumps(base))})")
        pg.on("pageerror", lambda e: self.page_errors.append(f"{e}"))
        # Failed requests are reported with their URL; the browser's matching console line is skipped.
        pg.on("response", lambda r: self.page_errors.append(f"HTTP {r.status} {r.request.method} {r.url}")
              if r.status >= 400 and not any(i in r.url or i == str(r.status) for i in ignore) else None)
        pg.on("console", lambda m: self.page_errors.append(m.text)
              if m.type == "error" and not m.text.startswith("Failed to load resource") and not any(i in m.text for i in ignore) else None)
        return pg

    def shot(self, page, name, **kw):
        if self.shots:
            page.screenshot(path=str(self.shots / f"{self.name}-{name}.png"), **kw)
