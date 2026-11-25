"""Cloud.ru model catalog; no inference calls or automatic network activity."""
import ctypes
from ctypes import wintypes
import json
import os
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from threading import RLock
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError, URLError

ENDPOINT = "https://foundation-models.api.cloud.ru/v1/models"
LOCK = RLock()
SESSION = {}

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def dpapi(data, decrypt=False):
    """Windows current-user protection; never write plaintext to disk."""
    if os.name != "nt":
        raise OSError("DPAPI unavailable")
    class Blob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]
    crypt = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    fn = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    fn.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    fn.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    buf = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
    source, result = Blob(len(data), buf), Blob()
    if not fn(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result)):
        raise OSError("Windows key protection unavailable")
    try:
        return ctypes.string_at(result.pbData, result.cbData)
    finally:
        ctypes.memset(result.pbData, 0, result.cbData)
        kernel.LocalFree(result.pbData)
        ctypes.memset(buf, 0, len(data))

def connect(path):
    db = sqlite3.connect(path, timeout=5)
    db.row_factory = sqlite3.Row
    db.execute("""CREATE TABLE IF NOT EXISTS cloud_config(id INTEGER PRIMARY KEY CHECK(id=1),
        model TEXT NOT NULL DEFAULT '', models TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'not_configured', checked TEXT,
        requests INTEGER NOT NULL DEFAULT 0, successes INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0, generation_requests INTEGER NOT NULL DEFAULT 0)""")
    db.execute("CREATE TABLE IF NOT EXISTS cloud_secret(id INTEGER PRIMARY KEY CHECK(id=1), protected BLOB NOT NULL)")
    db.execute("INSERT OR IGNORE INTO cloud_config(id) VALUES(1)")
    db.commit()
    return db

def read_key(db, path):
    if str(path) in SESSION:
        return SESSION[str(path)], "session"
    row = db.execute("SELECT protected FROM cloud_secret WHERE id=1").fetchone()
    if row:
        try:
            return dpapi(row[0], True).decode("utf-8"), "windows_dpapi"
        except (OSError, ValueError):
            return None, "locked"
    return None, "none"

def public_state(db, path):
    row = dict(db.execute("SELECT * FROM cloud_config WHERE id=1").fetchone())
    key, storage = read_key(db, path)
    status = row["status"] if key else ("key_locked" if storage == "locked" else "not_configured")
    if key and status == "not_configured":
        status = "configured"
    return {"provider":"Cloud.ru", "endpoint":ENDPOINT, "key_present":bool(key), "storage":storage,
            "model":row["model"], "models":json.loads(row["models"]), "status":status, "checked":row["checked"],
            "requests":row["requests"], "successes":row["successes"], "failures":row["failures"],
            "input_tokens":row["input_tokens"], "output_tokens":row["output_tokens"],
            "generation_requests":row["generation_requests"], "generation_enabled":bool(key and row["model"]), "capabilities":[__import__("gateway").classify(m) for m in json.loads(row["models"])]}

def state(path):
    with LOCK, closing(connect(path)) as db:
        return public_state(db, path)

def save(path, data):
    if set(data) - {"api_key", "model"}:
        raise ValueError("Unknown settings")
    with LOCK, closing(connect(path)) as db, db:
        if "api_key" in data:
            key = data["api_key"]
            if not isinstance(key, str) or not 8 <= len(key) <= 4096 or not key.isascii() or any(ord(c) <= 32 or ord(c) >= 127 for c in key):
                raise ValueError("Invalid API key")
            if os.name == "nt":
                try:
                    protected = dpapi(key.encode("utf-8"))
                except OSError:
                    raise ValueError("Windows cannot protect the key; it was not saved") from None
                db.execute("INSERT INTO cloud_secret VALUES(1,?) ON CONFLICT(id) DO UPDATE SET protected=excluded.protected", (protected,))
                SESSION.pop(str(path), None)
            else:
                SESSION[str(path)] = key
            db.execute("UPDATE cloud_config SET models='[]',model='',status='configured',checked=NULL WHERE id=1")
        if "model" in data:
            model = data["model"]
            models = json.loads(db.execute("SELECT models FROM cloud_config WHERE id=1").fetchone()[0])
            if not isinstance(model, str) or model not in models:
                raise ValueError("Select a model from the retrieved catalog")
            db.execute("UPDATE cloud_config SET model=? WHERE id=1", (model,))
        return public_state(db, path)

def fetch_models(key):
    req = Request(ENDPOINT, headers={"Authorization":"Bearer "+key, "Accept":"application/json"}, method="GET")
    try:
        with build_opener(NoRedirect()).open(req, timeout=12) as response:
            raw = response.read(2_000_001)
            if len(raw)>2_000_000:
                raise ValueError("Catalog too large")
            doc = json.loads(raw)
            if not isinstance(doc, dict) or not isinstance(doc.get("data"), list):
                raise ValueError("Invalid catalog")
            models = sorted({m["id"] for m in doc["data"] if isinstance(m,dict) and isinstance(m.get("id"),str) and 0<len(m["id"])<=300 and key not in m["id"]})[:2000]
            return models, "connected"
    except HTTPError as exc:
        return None, "unauthorized" if exc.code in (401,403) else "rate_limited" if exc.code==429 else "http_error"
    except (URLError, TimeoutError, OSError):
        return None, "network_error"
    except (ValueError, TypeError):
        return None, "invalid_response"

def refresh(path):
    # Serialize key changes and requests; only explicit POST reaches the network.
    with LOCK, closing(connect(path)) as db:
        key, _ = read_key(db,path)
        if not key:
            raise ValueError("Save an accessible API key first")
        with db:
            db.execute("UPDATE cloud_config SET requests=requests+1 WHERE id=1")
        models, status = fetch_models(key)
        checked = datetime.now(timezone.utc).isoformat()
        with db:
            if models is None:
                db.execute("UPDATE cloud_config SET failures=failures+1,status=?,checked=? WHERE id=1",(status,checked))
            else:
                row = db.execute("SELECT model FROM cloud_config WHERE id=1").fetchone()
                model = row["model"] if row["model"] in models else ""
                db.execute("UPDATE cloud_config SET successes=successes+1,status=?,checked=?,models=?,model=? WHERE id=1",
                    (status,checked,json.dumps(models,ensure_ascii=False),model))
        return public_state(db,path)
