"""Local-only atlas API and static frontend; no third-party Python packages."""
import argparse
import cloud_api
import logging
import secrets
import math
from datetime import datetime, timezone, date, timedelta
import json
import calendar
from io import BytesIO
from zipfile import ZipFile, ZIP_DEFLATED
from xml.sax.saxutils import escape
from urllib.request import urlopen
from urllib.error import URLError
from threading import Lock
import sqlite3
import webbrowser
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs
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
        db.executescript("""
        CREATE TABLE IF NOT EXISTS work_profiles(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, schedule TEXT NOT NULL, anchor TEXT NOT NULL, hours REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS work_days(profile_id INTEGER NOT NULL REFERENCES work_profiles(id), day TEXT NOT NULL, planned REAL, actual REAL, status TEXT NOT NULL, PRIMARY KEY(profile_id,day));
        CREATE TABLE IF NOT EXISTS time_snapshots(id INTEGER PRIMARY KEY, at TEXT NOT NULL, day TEXT NOT NULL, payload TEXT NOT NULL);
        """)
        db.execute("CREATE INDEX IF NOT EXISTS idx_events_at ON atlas_events(at)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_chat_created ON chat_messages(created_at)")
        columns = {r[1] for r in db.execute("PRAGMA table_info(nodes)")}
        if "folder" not in columns:
            db.execute("ALTER TABLE nodes ADD COLUMN folder TEXT NOT NULL DEFAULT ''")
        if "created_at" not in columns:
            db.execute("ALTER TABLE nodes ADD COLUMN created_at TEXT")
        db.execute("CREATE INDEX IF NOT EXISTS idx_nodes_folder ON nodes(folder)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_nodes_created ON nodes(created_at)")

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

def load_bundled_calendars():
    try:
        raw=(ROOT / "calendar" / "production-calendar.json").read_bytes()
        if len(raw)>262144:
            raise ValueError("Manifest too large")
        return save_calendar_manifest(json.loads(raw))
    except (OSError,ValueError,TypeError):
        return get_calendars()

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

# Local time ledger. Plan differences are not a legal determination of overtime.
def iso_day(value):
    if not isinstance(value,str) or len(value)!=10:
        raise ValueError("Invalid date")
    d=date.fromisoformat(value)
    if d.isoformat()!=value or not 2026<=d.year<=2100:
        raise ValueError("Date outside supported range")
    return d

def work_month(value):
    if not isinstance(value,str) or len(value)!=7:
        raise ValueError("Invalid month")
    return iso_day(value+"-01")

def hour_value(value,nullable=False):
    if value is None and nullable:
        return None
    if type(value) not in (int,float) or not math.isfinite(value) or not 0<=value<=24:
        raise ValueError("Hours must be between 0 and 24")
    return round(value,2)

def get_profiles():
    with closing(connect()) as db:
        return [dict(id=i,name=n,schedule=s,anchor=a,hours=h) for i,n,s,a,h in db.execute("SELECT id,name,schedule,anchor,hours FROM work_profiles ORDER BY id")]

def save_profile(data):
    name=data.get("name")
    if not isinstance(name,str) or not name.strip() or len(name.strip())>100 or any(ord(c)<32 for c in name):
        raise ValueError("Invalid employee name")
    schedule=data.get("schedule")
    if schedule not in ("5/2","6/1","2/2","shift"):
        raise ValueError("Invalid schedule")
    anchor=iso_day(data.get("anchor")).isoformat()
    hours=hour_value(data.get("hours"))
    if hours==0:
        raise ValueError("Positive shift duration required")
    with closing(connect()) as db,db:
        db.execute("BEGIN IMMEDIATE")
        if db.execute("SELECT COUNT(*) FROM work_profiles").fetchone()[0]>=200:
            raise ValueError("Local ledger supports up to 200 employees")
        db.execute("INSERT INTO work_profiles(name,schedule,anchor,hours) VALUES(?,?,?,?)",(name.strip(),schedule,anchor,hours))
    return get_profiles()

def save_work_day(data):
    pid=data.get("profile_id")
    if type(pid) is not int or pid<1:
        raise ValueError("Invalid employee")
    day=iso_day(data.get("day")).isoformat()
    status=data.get("status","normal")
    if status not in ("normal","leave","sick","trip","off"):
        raise ValueError("Invalid status")
    planned=hour_value(data.get("planned"),True)
    actual=hour_value(data.get("actual"),True)
    with closing(connect()) as db,db:
        if not db.execute("SELECT 1 FROM work_profiles WHERE id=?",(pid,)).fetchone():
            raise ValueError("Employee not found")
        db.execute("INSERT INTO work_days VALUES(?,?,?,?,?) ON CONFLICT(profile_id,day) DO UPDATE SET planned=excluded.planned,actual=excluded.actual,status=excluded.status",(pid,day,planned,actual,status))
    return work_report(day[:7])

def planned_hours(d,profile,rules):
    schedule=profile["schedule"]; h=profile["hours"]
    if schedule=="shift":
        return None
    if schedule=="2/2":
        return h if (d-date.fromisoformat(profile["anchor"])).days%4<2 else 0
    rule=rules.get(d.year)
    if schedule=="6/1":
        # Personal weekly pattern, NOT a certified six-day production calendar.
        return h if d.weekday()<6 and d.strftime("%m-%d") not in HOLIDAYS else 0
    if not rule:
        return None
    k=d.strftime("%m-%d")
    if k in HOLIDAYS or k in rule["rest"]:
        return 0
    if k in rule["short"]:
        return max(0,h-1)
    return h if d.weekday()<5 or k in rule["work"] else 0

def work_report(value):
    start=work_month(value)
    days=calendar.monthrange(start.year,start.month)[1]
    profiles=get_profiles()
    with closing(connect()) as db:
        rules={r["year"]:r for r in (json.loads(p[0]) for p in db.execute("SELECT payload FROM production_calendars"))}
        overrides={(p,d):(pl,ac,st) for p,d,pl,ac,st in db.execute("SELECT profile_id,day,planned,actual,status FROM work_days WHERE day>=? AND day<=?",(start.isoformat(),start.replace(day=days).isoformat()))}
    rows=[]; summary=[]
    for p in profiles:
        planned=actual=delta=0; unknown=missing=0
        for n in range(1,days+1):
            d=start.replace(day=n); k=d.isoformat()
            pl,ac,st=overrides.get((p["id"],k),(None,None,"normal"))
            override=pl
            if pl is None:
                pl=0 if st in ("leave","sick","off") else planned_hours(d,p,rules)
            diff=round(ac-pl,2) if ac is not None and pl is not None else None
            rows.append(dict(profile_id=p["id"],name=p["name"],day=k,planned=pl,override=override,actual=ac,status=st,difference=diff))
            if pl is None: unknown+=1
            else: planned+=pl
            if ac is None: missing+=1
            else: actual+=ac
            if diff is not None: delta+=diff
        summary.append(dict(profile_id=p["id"],name=p["name"],planned=round(planned,2),actual=round(actual,2),difference=round(delta,2),unknown=unknown,missing=missing))
    return dict(month=value,profiles=profiles,rows=rows,summary=summary)

def report_xlsx(value):
    report=work_report(value)
    # Minimal OpenXML workbook; all user strings are inline text, never formulas.
    def cell(v):
        if v is None: return "<c/>"
        if isinstance(v,(int,float)): return f"<c><v>{v}</v></c>"
        return '<c t="inlineStr"><is><t xml:space="preserve">'+escape(str(v))+'</t></is></c>'
    data=[["Сотрудник","Дата","План, ч","Факт, ч","Статус","Факт минус план, ч"]]
    names={"normal":"Обычный","leave":"Отпуск","sick":"Больничный","trip":"Командировка","off":"Выходной"}
    for r in report["rows"]:
        data.append([r["name"],r["day"],r["planned"],r["actual"],names[r["status"]],r["difference"]])
    xml=''.join('<row r="%s">%s</row>'%(i+1,''.join(cell(v) for v in row)) for i,row in enumerate(data))
    output=BytesIO()
    with ZipFile(output,"w",ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml",'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
        z.writestr("_rels/.rels",'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        z.writestr("xl/workbook.xml",'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Табель" sheetId="1" r:id="rId1"/></sheets></workbook>')
        z.writestr("xl/_rels/workbook.xml.rels",'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
        z.writestr("xl/worksheets/sheet1.xml",'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'+xml+'</sheetData></worksheet>')
    return output.getvalue()

def timeline_window(start,end):
    # UTC ISO bounds supplied from local-day/month boundaries in the browser.
    def bound(s):
        if not isinstance(s,str) or len(s)>40:
            raise ValueError("Invalid time")
        d=datetime.fromisoformat(s.replace("Z","+00:00"))
        if d.tzinfo is None:
            raise ValueError("Timezone required")
        return d.astimezone(timezone.utc)
    a,b=bound(start),bound(end)
    if not 0<(b-a).total_seconds()<=370*86400:
        raise ValueError("Invalid timeline window")
    low,high=a.isoformat(),b.isoformat()
    with closing(connect()) as db:
        # All existing timestamps are UTC ISO strings; no contents of private chats are returned.
        nodes=[dict(id=i,title=t,category=c,at=at) for i,t,c,at in db.execute("SELECT id,title,category,created_at FROM nodes WHERE created_at>=? AND created_at<? ORDER BY created_at,id LIMIT 500",(low,high))]
        events=[dict(at=a,kind=k,detail=d) for a,k,d in db.execute("SELECT at,kind,detail FROM atlas_events WHERE at>=? AND at<? ORDER BY at,id LIMIT 500",(low,high))]
        chats=[dict(at=a,kind="chat",detail="Сообщение пользователя") for a, in db.execute("SELECT created_at FROM chat_messages WHERE role='user' AND created_at>=? AND created_at<? ORDER BY created_at,id LIMIT 500",(low,high))]
        counts=dict(nodes=db.execute("SELECT COUNT(*) FROM nodes WHERE created_at>=? AND created_at<?",(low,high)).fetchone()[0],events=db.execute("SELECT COUNT(*) FROM atlas_events WHERE at>=? AND at<?",(low,high)).fetchone()[0],chats=db.execute("SELECT COUNT(*) FROM chat_messages WHERE role='user' AND created_at>=? AND created_at<?",(low,high)).fetchone()[0])
    return dict(nodes=nodes,events=events,chats=chats,counts=counts)

def save_time_snapshot(data):
    day=iso_day(data.get("day")).isoformat()
    mode=data.get("mode")
    if mode not in ("spiral","dna","galaxy","sphere","crystal","fabric","years","projection"):
        raise ValueError("Invalid mode")
    with closing(connect()) as db,db:
        payload={"mode":mode,"nodes":db.execute("SELECT COUNT(*) FROM nodes").fetchone()[0],"edges":db.execute("SELECT COUNT(*) FROM edges").fetchone()[0]}
        db.execute("INSERT INTO time_snapshots(at,day,payload) VALUES(?,?,?)",(datetime.now(timezone.utc).isoformat(),day,json.dumps(payload)))
    return get_time_snapshots()

def get_time_snapshots():
    with closing(connect()) as db:
        return [dict(id=i,at=a,day=d,**json.loads(p)) for i,a,d,p in db.execute("SELECT id,at,day,payload FROM time_snapshots ORDER BY id DESC LIMIT 100")]

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
    if "cinemaMode" in data:
        if data["cinemaMode"] not in ("auto", "cinema", "quiet", "off"):
            raise ValueError("Invalid cinema mode")
        out["cinemaMode"] = data["cinemaMode"]
    if "cinemaPower" in data:
        value = data["cinemaPower"]
        if type(value) not in (int,float) or not math.isfinite(value) or not 0 <= value <= 1:
            raise ValueError("Invalid cinema power")
        out["cinemaPower"] = value
    with closing(connect()) as db, db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT payload FROM ui_settings WHERE id=1").fetchone()
        previous = json.loads(row[0]) if row else {}
        previous.update(out)
        out = previous
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

STATIC = {"/favicon.svg":("favicon.svg","image/svg+xml"),"/":("index.html","text/html; charset=utf-8"),"/style.css":("style.css","text/css; charset=utf-8"),"/dist/app.js":("dist/app.js","text/javascript; charset=utf-8"),
    "/fonts/source-serif.woff2":("fonts/source-serif.woff2","font/woff2"),
    "/fonts/inter.ttf":("fonts/inter.ttf","font/ttf"),
    "/fonts/manrope.ttf":("fonts/manrope.ttf","font/ttf"),
    "/fonts/cormorant.woff2":("fonts/cormorant.woff2","font/woff2"),
    "/fonts/jetbrains-mono.ttf":("fonts/jetbrains-mono.ttf","font/ttf")
}

class LocalServer(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, address, handler):
        self.instance = secrets.token_hex(16)
        super().__init__(address, handler)

class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(20)

    def log_message(self, fmt, *args):
        logging.getLogger("http").info("%s %s", self.address_string(), fmt % args)

    def local_host(self):
        host = self.headers.get("Host", "").lower()
        port = self.server.server_port
        return host in {"127.0.0.1", "localhost", f"127.0.0.1:{port}", f"localhost:{port}"}

    def do_HEAD(self):
        self.do_GET()

    def reply(self,status,body,mime="application/json; charset=utf-8"):
        if not isinstance(body,bytes):
            body=json.dumps(body,ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type",mime)
        self.send_header("Content-Length",str(len(body)))
        self.send_header("X-Content-Type-Options","nosniff")
        self.send_header("Cache-Control","no-store")
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                self.close_connection = True

    def do_GET(self):
        if not self.local_host():
            self.reply(403, {"error": "Local host only"})
            return
        try:
            self.get_resource()
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True
        except sqlite3.Error:
            logging.exception("GET database error")
            self.reply(503, {"error": "Database unavailable"})
        except (ValueError, TypeError):
            self.reply(400, {"error": "Invalid parameters"})
        except Exception:
            logging.exception("GET failure")
            self.reply(500, {"error": "Internal server error"})

    def get_resource(self):
        path=urlsplit(self.path).path
        if path=="/api/health":
            self.reply(200,{"app":"Amatsumireika","instance":self.server.instance,"ready":True})
        elif path=="/api/cloud/settings":
            self.reply(200,cloud_api.state(DB))
        elif path=="/api/atlas":
            self.reply(200,snapshot())
        elif path=="/api/calendar":
            self.reply(200,get_calendars())
        elif path in ("/api/work/profiles","/api/work/report","/api/work/export","/api/time/window","/api/time/snapshots"):
            query=parse_qs(urlsplit(self.path).query)
            try:
                if path=="/api/work/profiles":
                    self.reply(200,get_profiles())
                elif path=="/api/work/report":
                    self.reply(200,work_report(query.get("month",[""])[0]))
                elif path=="/api/work/export":
                    self.reply(200,report_xlsx(query.get("month",[""])[0]),"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
                elif path=="/api/time/window":
                    self.reply(200,timeline_window(query.get("start",[""])[0],query.get("end",[""])[0]))
                else:
                    self.reply(200,get_time_snapshots())
            except (ValueError,TypeError):
                self.reply(400,{"error":"Invalid parameters"})
            except sqlite3.Error:
                self.reply(503,{"error":"Database unavailable"})
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
        if not self.local_host() or self.headers.get("Origin") not in (None,"http://"+self.headers.get("Host","")) or self.headers.get_content_type()!="application/json":
            self.reply(403,{"error":"Local JSON requests only"})
            return
        try:
            n=int(self.headers.get("Content-Length","0"))
            if not 0<n<=16384:
                self.close_connection = True
                raise ValueError("Invalid request length")
            data=json.loads(self.rfile.read(n))
            if not isinstance(data,dict):
                raise ValueError("Expected object")
            if self.path=="/api/cloud/settings":
                self.reply(200,cloud_api.save(DB,data))
                return
            if self.path=="/api/cloud/models":
                if data != {"confirm": True}:
                    raise ValueError("Explicit catalog request required")
                self.reply(200,cloud_api.refresh(DB))
                return
            if self.path=="/api/calendar/refresh":
                self.reply(200,refresh_calendars())
                return
            if self.path=="/api/work/profiles":
                self.reply(200,save_profile(data))
                return
            if self.path=="/api/work/day":
                self.reply(200,save_work_day(data))
                return
            if self.path=="/api/time/snapshots":
                self.reply(200,save_time_snapshot(data))
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
            logging.exception("POST database error")
            self.reply(503,{"error":"Database unavailable"})
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True
        except Exception:
            logging.exception("POST failure")
            self.reply(500,{"error":"Internal server error"})

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--open",action="store_true")
    parser.add_argument("--port",type=int,default=0)
    args=parser.parse_args()
    initialize()
    load_bundled_calendars()
    logging.basicConfig(level=logging.INFO,format="%(levelname)s %(message)s")
    with LocalServer(("127.0.0.1",args.port),Handler) as server:
        url=f"http://127.0.0.1:{server.server_port}"
        print(url,flush=True)
        if args.open:
            try:
                if not webbrowser.open(url):
                    print("Open the URL manually.",flush=True)
            except Exception:
                logging.exception("Browser launch failed; server remains available")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass

if __name__=="__main__":
    main()
