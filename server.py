"""Local-only atlas API and static frontend; no third-party Python packages."""
import argparse
import math
from datetime import datetime, timezone
import json
import sqlite3
import webbrowser
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from contextlib import closing

ROOT = Path(__file__).resolve().parent
CATEGORIES = ("Личность", "Знания", "Навыки", "Опыт", "Документы", "Цели", "Эмоции", "Логика", "Воспоминания")
DB = ROOT / "data" / "amatsumireika.db"

def connect():
    DB.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB, timeout=5)
    db.execute("PRAGMA foreign_keys=ON")
    return db

def initialize():
    with closing(connect()) as db, db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS nodes(id INTEGER PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS edges(source INTEGER REFERENCES nodes(id), target INTEGER REFERENCES nodes(id), PRIMARY KEY(source,target), CHECK(source<target));
        """)
        db.execute("CREATE TABLE IF NOT EXISTS ui_settings(id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)")
        db.execute("CREATE TABLE IF NOT EXISTS atlas_events(id INTEGER PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL)")
        columns = {r[1] for r in db.execute("PRAGMA table_info(nodes)")}
        if "folder" not in columns:
            db.execute("ALTER TABLE nodes ADD COLUMN folder TEXT NOT NULL DEFAULT ''")
        if "created_at" not in columns:
            db.execute("ALTER TABLE nodes ADD COLUMN created_at TEXT")
        db.execute("CREATE INDEX IF NOT EXISTS idx_nodes_folder ON nodes(folder)")

def event(db, kind, detail):
    db.execute("INSERT INTO atlas_events(at,kind,detail) VALUES(?,?,?)",
               (datetime.now(timezone.utc).isoformat(), kind, detail))

def get_settings():
    with closing(connect()) as db:
        row = db.execute("SELECT payload FROM ui_settings WHERE id=1").fetchone()
        return json.loads(row[0]) if row else {}

def save_settings(data):
    if not isinstance(data, dict):
        raise ValueError("Invalid settings")
    limits = {"speed": (0,2), "density": (12,180), "strength": (0,1), "groupSize": (.55,1)}
    out = {}
    for key, (low,high) in limits.items():
        if key in data:
            value = data[key]
            if type(value) not in (int,float) or not math.isfinite(value) or not low <= value <= high:
                raise ValueError("Invalid "+key)
            out[key] = value
    if "palette" in data:
        if data["palette"] not in ("Океан","Императорская","Полярная","Металл","Рубин","Неон","Бордо","Бумага"):
            raise ValueError("Invalid palette")
        out["palette"] = data["palette"]
    if "showLabels" in data:
        if type(data["showLabels"]) is not bool:
            raise ValueError("Invalid labels")
        out["showLabels"] = data["showLabels"]
    with closing(connect()) as db, db:
        db.execute("INSERT INTO ui_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",(json.dumps(out,ensure_ascii=False),))
        event(db,"settings","Визуальные настройки сохранены")
    return out

def get_events():
    with closing(connect()) as db:
        return [dict(at=a,kind=k,detail=d) for a,k,d in db.execute("SELECT at,kind,detail FROM atlas_events ORDER BY id DESC LIMIT 500")]

def snapshot():
    with closing(connect()) as db:
        db.execute("BEGIN")
        return {"nodes":[dict(id=i,title=t,category=c,folder=f,created_at=at) for i,t,c,f,at in db.execute("SELECT id,title,category,folder,created_at FROM nodes ORDER BY id")],
                "edges":[dict(source=s,target=t) for s,t in db.execute("SELECT source,target FROM edges ORDER BY source,target")],
                "categories":CATEGORIES}

def add_node(title, category, folder=""):
    if not isinstance(title,str) or not title.strip() or len(title.strip())>160 or category not in CATEGORIES:
        raise ValueError("Invalid title or category")
    if not isinstance(folder,str) or len(folder)>120 or any(ord(c)<32 for c in folder):
        raise ValueError("Invalid folder")
    folder = "/".join(p.strip() for p in folder.replace("\\","/").split("/") if p.strip())
    if any(p in (".","..") for p in folder.split("/")):
        raise ValueError("Invalid folder path")
    with closing(connect()) as db, db:
        node_id = db.execute("INSERT INTO nodes(title,category,folder,created_at) VALUES(?,?,?,?)",(title.strip(),category,folder,datetime.now(timezone.utc).isoformat())).lastrowid
        event(db,"node",title.strip())
        return node_id

def add_edge(source,target):
    if type(source) is not int or type(target) is not int or source<=0 or target<=0 or source==target:
        raise ValueError("Select two different records")
    with closing(connect()) as db, db:
        result = db.execute("INSERT OR IGNORE INTO edges VALUES(?,?)",tuple(sorted((source,target))))
        if result.rowcount:
            event(db,"edge",f"Связь {source} ↔ {target}")

STATIC = {"/":("index.html","text/html; charset=utf-8"),"/style.css":("style.css","text/css; charset=utf-8"),"/dist/app.js":("dist/app.js","text/javascript; charset=utf-8")}

class Handler(BaseHTTPRequestHandler):
    def reply(self,status,body,mime="application/json; charset=utf-8"):
        if not isinstance(body,bytes):
            body=json.dumps(body,ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type",mime)
        self.send_header("Content-Length",str(len(body)))
        self.send_header("X-Content-Type-Options","nosniff")
        self.send_header("Cache-Control","no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path=urlsplit(self.path).path
        if path=="/api/atlas":
            self.reply(200,snapshot())
        elif path=="/api/settings":
            self.reply(200,get_settings())
        elif path=="/api/events":
            self.reply(200,get_events())
        elif path in STATIC:
            name,mime=STATIC[path]
            try:
                self.reply(200,(ROOT/name).read_bytes(),mime)
            except FileNotFoundError:
                self.reply(503,{"error":"Build frontend: npm run build"})
        else:
            self.reply(404,{"error":"Not found"})

    def do_POST(self):
        if self.headers.get("Origin") not in (None,"http://"+self.headers.get("Host","")) or self.headers.get_content_type()!="application/json":
            self.reply(403,{"error":"Local JSON requests only"})
            return
        try:
            n=int(self.headers.get("Content-Length","0"))
            if not 0<n<=16384:
                raise ValueError("Invalid request length")
            data=json.loads(self.rfile.read(n))
            if not isinstance(data,dict):
                raise ValueError("Expected object")
            if self.path=="/api/settings":
                self.reply(200,save_settings(data))
                return
            if self.path=="/api/nodes":
                add_node(data.get("title"),data.get("category"),data.get("folder",""))
            elif self.path=="/api/edges":
                add_edge(data.get("source"),data.get("target"))
            else:
                self.reply(404,{"error":"Not found"})
                return
            self.reply(200,snapshot())
        except (ValueError,TypeError,sqlite3.IntegrityError) as exc:
            self.reply(400,{"error":str(exc)})
        except sqlite3.Error:
            self.reply(503,{"error":"Database unavailable"})

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--open",action="store_true")
    parser.add_argument("--port",type=int,default=0)
    args=parser.parse_args()
    initialize()
    with ThreadingHTTPServer(("127.0.0.1",args.port),Handler) as server:
        url=f"http://127.0.0.1:{server.server_port}"
        print(url,flush=True)
        if args.open:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass

if __name__=="__main__":
    main()
