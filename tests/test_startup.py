import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import launcher
import server

class StartupTest(unittest.TestCase):
    def test_lock_releases_and_excludes(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "lock"
            a, b = launcher.InstanceLock(path), launcher.InstanceLock(path)
            try:
                self.assertTrue(a.acquire())
                self.assertFalse(b.acquire())
                a.close()
                self.assertTrue(b.acquire())
            finally:
                a.close()
                b.close()

    def test_http_health_favicon_and_errors(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(server, "DB", Path(tmp) / "test.db"):
            server.initialize()
            with server.LocalServer(("127.0.0.1", 0), server.Handler) as app:
                t = threading.Thread(target=app.serve_forever, daemon=True)
                t.start()
                def request(method, path, host=None):
                    c = http.client.HTTPConnection("127.0.0.1", app.server_port, timeout=3)
                    try:
                        c.request(method, path, headers={"Host": host} if host else {})
                        response = c.getresponse()
                        return response.status, response.getheader("Content-Type"), response.read()
                    finally:
                        c.close()
                try:
                    state = Path(tmp) / "instance.json"
                    state.write_text(json.dumps({"port": app.server_port, "instance": app.instance}))
                    self.assertEqual(launcher.existing_url(state), f"http://127.0.0.1:{app.server_port}")
                    self.assertEqual(request("GET", "/favicon.svg")[0:2], (200, "image/svg+xml"))
                    self.assertEqual(request("HEAD", "/favicon.svg")[2], b"")
                    self.assertEqual(request("GET", "/missing")[0], 404)
                    self.assertEqual(request("GET", "/api/atlas", "external.example")[0], 403)
                    with patch.object(server, "snapshot", side_effect=server.sqlite3.OperationalError("test")):
                        self.assertEqual(request("GET", "/api/atlas")[0], 503)
                finally:
                    app.shutdown()
                    t.join(timeout=3)
