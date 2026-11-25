"""Local-only atlas API and static frontend; no third-party Python packages."""
import argparse
import math
from datetime import datetime, timezone, date, timedelta
import json
from urllib.request import urlopen
from urllib.error import URLError
from threading import Lock
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
        db.execute("CREATE TABLE IF NOT EXISTS chat_messages(id INTEGER PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('user','system')), content TEXT NOT NULL, created_at TEXT NOT NULL)")
        db.execute("CREATE TABLE IF NOT EXISTS production_calendars(year INTEGER PRIMARY KEY, payload TEXT NOT NULL)")
        columns = {r[1] for r in db.execute("PRAGMA table_info(nodes)")}
        if "folder" not in columns:
            db.execute("ALTER TABLE nodes ADD COLUMN folder TEXT NOT NULL DEFAULT ''")
        if "created_at" not in columns:
            db.execute("ALTER TABLE nodes ADD COLUMN created_at TEXT")
        db.execute("CREATE INDEX IF NOT EXISTS idx_nodes_folder ON nodes(folder)")

def event(db, kind, detail):
    db.execute("INSERT INTO atlas_events(at,kind,detail) VALUES(?,?,?)",
               (datetime.now(timezone.utc).isoformat(), kind, detail))

# Only reviewed manifests in this project's canonical repository are accepted.
CALENDAR_FEED = "https://raw.githubusercontent.com/Aspksa/Amatsumireika/main/calendar/production-calendar.json"
CALENDAR_LOCK = Lock()
HOLIDAYS = {"01-01","01-02","01-03","01-04","01-05","01-06","01-07","01-08","02-23","03-08","05-01","05-09","06-12","11-04"}

def validate_calendar(record):
    if not isinstance(record, dict):
        raise ValueError("Invalid calendar")
    y = record.get("year")
    if type(y) is not int or not 2026 <= y <= 2100:
        raise ValueError("Invalid year")
    source = record.get("source")
    if not isinstance(source,str) or len(source)>500:
        raise ValueError("Missing source")
    url = urlsplit(source)
    if url.scheme!="https" or url.hostname not in {"publication.pravo.gov.ru","pravo.gov.ru","government.ru","www.consultant.ru","base.garant.ru"} or url.username or url.password or not url.path.strip("/"):
        raise ValueError("Untrusted source")
    if record.get("reviewed") is not True or not isinstance(record.get("decree"),str) or not record["decree"].strip() or len(record["decree"])>160:
        raise ValueError("Maintainer review and decree required")
    groups = {}
    for key in ("rest","short","work"):
        values=record.get(key,[])
        if not isinstance(values,list) or len(values)>366 or any(not isinstance(v,str) for v in values):
            raise ValueError("Invalid days")
        for v in values:
            if date.fromisoformat(f"{y}-{v}").strftime("%m-%d")!=v or v in HOLIDAYS:
                raise ValueError("Invalid override")
        if len(set(values))!=len(values):
            raise ValueError("Duplicate day")
        groups[key]=set(values)
    if any(groups[a]&groups[b] for a,b in (("rest","short"),("rest","work"),("short","work"))):
        raise ValueError("Conflicting overrides")
    d=date(y,1,1); days=0; work=0; short=0
    while d.year==y:
        key=d.strftime("%m-%d"); days+=1
        if key not in HOLIDAYS and key not in groups["rest"] and (key in groups["short"] or key in groups["work"] or d.weekday()<5):
            work+=1; short+=int(key in groups["short"])
        d+=timedelta(days=1)
    expected={"work":work,"rest":days-work,"short":short,"h40":work*8-short}
    if record.get("totals")!=expected:
        raise ValueError("Totals mismatch")
    return dict(year=y,source=source,decree=record["decree"],reviewed=True,rest=sorted(groups["rest"]),short=sorted(groups["short"]),work=sorted(groups["work"]),totals=expected)

def save_calendar_manifest(manifest):
    if not isinstance(manifest,dict) or manifest.get("schema")!=1 or not isinstance(manifest.get("calendars"),list) or len(manifest["calendars"])>75:
        raise ValueError("Invalid manifest")
    records=[validate_calendar(r) for r in manifest["calendars"]]
    if len({r["year"] for r in records})!=len(records):
        raise ValueError("Duplicate year")
    with closing(connect()) as db, db:
        for r in records:
            db.execute("INSERT OR IGNORE INTO production_calendars(year,payload) VALUES(?,?)",(r["year"],json.dumps(r,ensure_ascii=False)))
    return get_calendars()

def get_calendars():
    with closing(connect()) as db:
        return {"calendars":[json.loads(r[0]) for r in db.execute("SELECT payload FROM production_calendars ORDER BY year")],"status":"Локальные данные"}

def refresh_calendars():
    if not CALENDAR_LOCK.acquire(blocking=False):
        return {**get_calendars(),"status":"Обновление уже выполняется"}
    try:
        # No user-provided fetch URL, no credentials, bounded response.
        with urlopen(CALENDAR_FEED,timeout=5) as response:
            if response.geturl()!=CALENDAR_FEED:
                raise ValueError("Unexpected redirect")
            raw=response.read(262145)
        if len(raw)>262144:
            raise ValueError("Manifest too large")
        result=save_calendar_manifest(json.loads(raw))
        result["status"]="Проверены структура и нормы · источник: проверенный сопровождающим манифест"
        return result
    except (OSError,URLError,ValueError,TypeError):
        return {**get_calendars(),"status":"Обновление не принято · локальные данные сохранены"}
    finally:
        CALENDAR_LOCK.release()

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

def chat_history(db):
    rows = db.execute("SELECT id,role,content,created_at FROM chat_messages ORDER BY id DESC LIMIT 200").fetchall()
    return {"messages":[dict(id=i,role=r,content=c,created_at=a) for i,r,c,a in reversed(rows)],"model_connected":False}

def get_chat():
    with closing(connect()) as db:
        return chat_history(db)

def send_chat(content):
    if not isinstance(content,str) or not content.strip() or len(content.strip())>3000:
        raise ValueError("Сообщение должно содержать от 1 до 3000 символов")
    content=content.strip()
    with closing(connect()) as db, db:
        def append(role,body):
            db.execute("INSERT INTO chat_messages(role,content,created_at) VALUES(?,?,?)",
                       (role,body,datetime.now(timezone.utc).isoformat()))
        append("user",content)
        command=content.casefold()
        if command=="/помощь":
            append("system","Локальные команды: /статус — состояние базы и количество записей и связей. Языковая модель не подключена.")
        elif command=="/статус":
            count=db.execute("SELECT COUNT(*) FROM nodes").fetchone()[0]
            links=db.execute("SELECT COUNT(*) FROM edges").fetchone()[0]
            append("system",f"SQLite работает. Записей: {count}; связей: {links}. Языковая модель не подключена.")
        else:
            append("system","Сообщение сохранено. Для ответа ИИ необходимо подключить языковую модель.")
        return chat_history(db)

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
        elif path=="/api/calendar":
            self.reply(200,get_calendars())
        elif path=="/api/chat":
            self.reply(200,get_chat())
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
            if self.path=="/api/calendar/refresh":
                self.reply(200,refresh_calendars())
                return
            if self.path=="/api/chat":
                self.reply(200,send_chat(data.get("content")))
                return
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
