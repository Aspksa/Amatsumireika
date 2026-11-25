"""Portable standard-library launcher."""
import argparse
import contextlib
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from urllib.request import urlopen
import webbrowser
from threading import Thread
import frontend_build
import server

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
LOG = logging.getLogger("startup")

class InstanceLock:
    def __init__(self, path):
        self.path = path
        self.file = None
    def acquire(self):
        self.file = self.path.open("a+b")
        if self.file.seek(0, 2) == 0:
            self.file.write(b"0")
            self.file.flush()
        self.file.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            self.file.close()
            self.file = None
            return False
    def close(self):
        if self.file:
            self.file.close()
            self.file = None

def existing_url(path):
    try:
        info = json.loads(path.read_text(encoding="utf-8"))
        port, token = info["port"], info["instance"]
        if type(port) is not int or not 1 <= port <= 65535 or not isinstance(token, str):
            return None
        url = f"http://127.0.0.1:{port}"
        with urlopen(url + "/api/health", timeout=1) as response:
            health = json.load(response)
        if health == {"app": "Amatsumireika", "instance": token, "ready": True}:
            return url
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return None

def open_browser(url):
    try:
        if not webbrowser.open(url):
            LOG.warning("Browser did not open automatically. Open the URL manually.")
    except Exception:
        LOG.warning("Browser launch failed; open %s manually.", url, exc_info=True)

def build_frontend():
    if frontend_build.current(ROOT):
        LOG.info("Frontend integrity OK; Node.js not needed.")
        return
    LOG.info("Frontend needs rebuilding.")
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if not npm:
        raise RuntimeError("Node.js/npm is required only for rebuilding.")
    def run(*args):
        command = ["cmd.exe", "/d", "/c", "npm.cmd", *args] if os.name == "nt" else [npm, *args]
        result = subprocess.run(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=300)
        for line in result.stdout.decode("utf-8", errors="replace").splitlines():
            LOG.info("%s", line)
        result.check_returncode()
    if not (ROOT / "node_modules" / "typescript" / "bin" / "tsc").is_file():
        run("install", "--no-audit", "--no-fund")
    run("run", "build")
    frontend_build.seal(ROOT)
    if not frontend_build.current(ROOT):
        raise RuntimeError("Frontend integrity verification failed.")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--no-open", action="store_true")
    args = parser.parse_args()
    DATA.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", handlers=[
        logging.StreamHandler(sys.stdout),
        RotatingFileHandler(DATA / "startup.log", maxBytes=1_000_000, backupCount=2, encoding="utf-8")])
    state = DATA / "instance.json"
    lock = InstanceLock(DATA / "instance.lock")
    if not lock.acquire():
        if args.check:
            LOG.error("Another instance holds the startup lock.")
            return 1
        for _ in range(10):
            url = existing_url(state)
            if url:
                LOG.info("Already running: %s", url)
                if not args.no_open:
                    open_browser(url)
                return 0
            time.sleep(.5)
        LOG.warning("Another startup is in progress; use its original console.")
        return 0
    try:
        state.unlink(missing_ok=True)
        build_frontend()
        server.initialize()
        if not args.check:
            server.gateway.recover(server.DB)
        server.load_bundled_calendars()
        if args.check:
            LOG.info("CHECK OK: frontend SHA-256 and SQLite initialization.")
            return 0
        with server.LocalServer(("127.0.0.1", 0), server.Handler) as http:
            temp = state.with_suffix(".tmp")
            temp.write_text(json.dumps({"port": http.server_port, "instance": http.instance}), encoding="utf-8")
            temp.replace(state)
            url = f"http://127.0.0.1:{http.server_port}"
            LOG.info("READY: %s", url)
            LOG.info("Keep this window open. Ctrl+C stops the server.")
            if not args.no_open:
                Thread(target=open_browser, args=(url,), daemon=True).start()
            try:
                http.serve_forever()
            except KeyboardInterrupt:
                LOG.info("Server stopped.")
        return 0
    except Exception:
        LOG.exception("Startup failed")
        return 1
    finally:
        with contextlib.suppress(OSError):
            state.unlink(missing_ok=True)
        lock.close()

if __name__ == "__main__":
    sys.exit(main())
