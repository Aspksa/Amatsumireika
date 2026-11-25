"""Local-only atlas API and static frontend; no third-party Python packages."""
import argparse
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

def snapshot():
    with closing(connect()) as db:
        db.execute("BEGIN")
        return {"nodes":[dict(id=i,title=t,category=c) for i,t,c in db.execute("SELECT id,title,category FROM nodes ORDER BY id")],
                "edges":[dict(source=s,target=t) for s,t in db.execute("SELECT source,target FROM edges ORDER BY source,target")],
                "categories":CATEGORIES}

def add_node(title, category):
    if not isinstance(title,str) or not title.strip() or len(title.strip())>160 or category not in CATEGORIES:
        raise ValueError("Invalid title or category")
    with closing(connect()) as db, db:
        return db.execute("INSERT INTO nodes(title,category) VALUES(?,?)",(title.strip(),category)).lastrowid

def add_edge(source,target):
    if type(source) is not int or type(target) is not int or source<=0 or target<=0 or source==target:
        raise ValueError("Select two different records")
    with closing(connect()) as db, db:
        db.execute("INSERT OR IGNORE INTO edges VALUES(?,?)",tuple(sorted((source,target))))

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
            if self.path=="/api/nodes":
                add_node(data.get("title"),data.get("category"))
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
