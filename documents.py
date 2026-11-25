"""Portable local document storage. No network, executable content or external libraries."""
import base64
import binascii
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sqlite3
import uuid
import zipfile
import xml.etree.ElementTree as ET
import memory_engine as memory

MAX_BYTES=20*1024*1024
MAX_TEXT=200000
MAX_XML=8*1024*1024
EXTENSIONS={".txt",".md",".csv",".json",".log",".pdf",".docx",".xlsx",".png",".jpg",".jpeg",".webp",".gif",".odt",".ods"}
TEXT_EXT={".txt",".md",".csv",".json",".log"}
W="{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
S="{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
def now():return datetime.now(timezone.utc).isoformat()
def root(path):return path.parent/"Aspksa"/"Документы"
def init(db):
    db.execute("""CREATE TABLE IF NOT EXISTS documents(id INTEGER PRIMARY KEY,node_id INTEGER NOT NULL UNIQUE REFERENCES nodes(id),name TEXT NOT NULL,folder TEXT NOT NULL,blob TEXT NOT NULL,sha256 TEXT NOT NULL,size INTEGER NOT NULL,created TEXT NOT NULL,deleted TEXT,extract_status TEXT NOT NULL,content TEXT NOT NULL)""")
    db.execute("CREATE INDEX IF NOT EXISTS documents_folder ON documents(deleted,folder,id)")
    db.execute("CREATE INDEX IF NOT EXISTS documents_hash ON documents(sha256)")
    db.execute("CREATE TABLE IF NOT EXISTS document_folders(path TEXT PRIMARY KEY,created TEXT NOT NULL)")
    db.execute("CREATE TABLE IF NOT EXISTS document_terms(term TEXT NOT NULL,document_id INTEGER NOT NULL REFERENCES documents(id),PRIMARY KEY(term,document_id))")
    db.execute("CREATE INDEX IF NOT EXISTS document_terms_id ON document_terms(document_id)")
    db.execute("CREATE TABLE IF NOT EXISTS document_events(id INTEGER PRIMARY KEY,at TEXT NOT NULL,document_id INTEGER,kind TEXT NOT NULL)")
def connect(path):
    db=sqlite3.connect(path,timeout=10)
    db.row_factory=sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    memory.register(db)
    return db
def folder(value):
    if not isinstance(value,str) or len(value)>120:raise ValueError("Некорректная папка")
    parts=[p.strip() for p in value.replace("\\","/").split("/") if p.strip()]
    if any(p in (".","..") or any(ord(c)<32 or c in '<>:"|?*' for c in p) for p in parts):raise ValueError("Некорректная папка")
    return "/".join(parts)
def filename(value):
    if not isinstance(value,str) or not 1<=len(value)<=150 or value!=value.strip() or value.endswith(".") or any(ord(c)<32 or c in '/\\<>:"|?*' for c in value):raise ValueError("Некорректное имя файла")
    if value.split(".")[0].upper() in {"CON","PRN","AUX","NUL",*[f"COM{i}" for i in range(1,10)],*[f"LPT{i}" for i in range(1,10)]}:raise ValueError("Зарезервированное имя")
    if Path(value).suffix.lower() not in EXTENSIONS:raise ValueError("Формат не поддерживается")
    return value
def xml(z,name):
    info=z.getinfo(name)
    if info.file_size>MAX_XML:raise ValueError("XML слишком большой")
    data=z.read(info)
    # Reject declarations, including UTF-16 forms, before parsing.
    low=data.replace(b"\0",b"").lower()
    if b"<!doctype" in low or b"<!entity" in low:raise ValueError("Небезопасный XML")
    return ET.fromstring(data)
def extract(name,data):
    ext=Path(name).suffix.lower()
    if ext in TEXT_EXT:
        for enc in ("utf-8-sig","utf-16") if data.startswith((b"\xff\xfe",b"\xfe\xff")) else ("utf-8-sig","cp1251"):
            try:return "indexed",data.decode(enc)[:MAX_TEXT]
            except UnicodeError:pass
        return "unsupported_encoding",""
    if ext in (".docx",".xlsx",".odt",".ods"):
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                if len(z.infolist())>2000 or sum(i.file_size for i in z.infolist())>64*1024*1024:raise ValueError("Архив слишком большой")
                if ext==".docx":
                    body=xml(z,"word/document.xml")
                    out="\n".join("".join(t.text or "" for t in p.iter(W+"t")) for p in body.iter(W+"p"))
                elif ext==".xlsx":
                    shared=[]
                    if "xl/sharedStrings.xml" in z.namelist():shared=["".join(t.text or "" for t in i.iter(S+"t")) for i in xml(z,"xl/sharedStrings.xml").iter(S+"si")]
                    lines=[]
                    for sheet in sorted(n for n in z.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml",n))[:50]:
                        lines.append(sheet)
                        for row in xml(z,sheet).iter(S+"row"):
                            vals=[]
                            for cell in row.iter(S+"c"):
                                v=cell.findtext(S+"v","")
                                if cell.get("t")=="s" and v.isdecimal() and int(v)<len(shared):v=shared[int(v)]
                                elif cell.get("t")=="inlineStr":v="".join(t.text or "" for t in cell.iter(S+"t"))
                                vals.append(v)
                            lines.append("\t".join(vals))
                    out="\n".join(lines)
                else:
                    body=xml(z,"content.xml")
                    out="\n".join("".join(p.itertext()) for p in body.iter() if p.tag.endswith("}p"))
                return ("indexed" if out.strip() else "empty_text"),out[:MAX_TEXT]
        except (ValueError,KeyError,ET.ParseError,zipfile.BadZipFile,RuntimeError,NotImplementedError,OSError):
            return "extraction_failed",""
    # PDF and images are preserved and previewed; no pretend PDF parser or OCR.
    return "preview_only",""
def event(db,ident,kind,node=None):
    db.execute("INSERT INTO document_events(at,document_id,kind) VALUES(?,?,?)",(now(),ident,kind))
    if memory.table(db,"cog_events"):
        db.execute("INSERT INTO cog_events(at,kind,detail,node_id) VALUES(?,?,?,?)",(now(),"document",kind,node))
def meta(row):return {k:row[k] for k in ("id","node_id","name","folder","size","sha256","created","deleted","extract_status")}
def get(db,ident,active=True):
    if type(ident) is not int or ident<=0:raise ValueError("Некорректный ID")
    row=db.execute("SELECT * FROM documents WHERE id=?",(ident,)).fetchone()
    if not row or (active and row["deleted"]):raise ValueError("Документ недоступен")
    return row
def path_for(path,blob):
    if not re.fullmatch(r"[a-f0-9]{32}",blob):raise ValueError("Некорректное хранилище")
    base=root(path).resolve()
    target=base/blob
    if target.is_symlink() or target.resolve().parent!=base:raise ValueError("Недопустимый путь")
    return target
def upload(path,data):
    name=filename(data.get("name"));where=folder(data.get("folder",""))
    encoded=data.get("data")
    if not isinstance(encoded,str) or len(encoded)>4*((MAX_BYTES+2)//3):raise ValueError("Файл слишком большой")
    try:raw=base64.b64decode(encoded,validate=True)
    except (ValueError,binascii.Error):raise ValueError("Некорректные данные файла")
    if not 0<len(raw)<=MAX_BYTES:raise ValueError("Файл пуст или больше 20 МБ")
    ext=Path(name).suffix.lower()
    if ext==".pdf" and not raw.startswith(b"%PDF-"):raise ValueError("Не PDF")
    if ext in (".docx",".xlsx",".odt",".ods") and not zipfile.is_zipfile(io.BytesIO(raw)):raise ValueError("Не офисный архив")
    if ext==".png" and not raw.startswith(b"\x89PNG\r\n\x1a\n"):raise ValueError("Не PNG")
    if ext in (".jpg",".jpeg") and not raw.startswith(b"\xff\xd8\xff"):raise ValueError("Не JPEG")
    if ext==".gif" and raw[:6] not in (b"GIF87a",b"GIF89a"):raise ValueError("Не GIF")
    if ext==".webp" and not (raw[:4]==b"RIFF" and raw[8:12]==b"WEBP"):raise ValueError("Не WebP")
    sha=hashlib.sha256(raw).hexdigest()
    status,content=extract(name,raw)
    blob=uuid.uuid4().hex
    root(path).mkdir(parents=True,exist_ok=True)
    target=path_for(path,blob)
    tmp=target.with_suffix(".tmp")
    try:
        with closing(connect(path)) as db:
            db.execute("BEGIN IMMEDIATE")
            old=db.execute("SELECT * FROM documents WHERE deleted IS NULL AND memory_norm(name)=? AND folder=? AND sha256=?",(memory.norm(name),where,sha)).fetchone()
            if old:
                db.rollback()
                return {**meta(old),"duplicate":True}
            with tmp.open("xb") as out:
                out.write(raw);out.flush();os.fsync(out.fileno())
            os.replace(tmp,target)
            try:
                node=db.execute("INSERT INTO nodes(title,category,folder,created_at) VALUES(?,?,?,?)",(name,"Документы",where,now())).lastrowid
                ident=db.execute("INSERT INTO documents(node_id,name,folder,blob,sha256,size,created,extract_status,content) VALUES(?,?,?,?,?,?,?,?,?)",(node,name,where,blob,sha,len(raw),now(),status,content)).lastrowid
                db.executemany("INSERT OR IGNORE INTO document_terms VALUES(?,?)",((w,ident) for w in memory.terms(name+" "+where+" "+content) if len(w)<=80))
                import cognitive
                db.execute("INSERT INTO cog_memory(node_id,kind,subject,fingerprint,source,at,confidence,priority) VALUES(?,?,?,?,?,?,?,?)",(node,"document","",sha,"document:"+str(ident),now(),1,2))
                db.execute("INSERT INTO atlas_events(at,kind,detail) VALUES(?,?,?)",(now(),"node","Документ: "+name))
                event(db,ident,"Документ загружен",node)
                result=meta(get(db,ident))
                db.commit()
            except BaseException:
                db.rollback();target.unlink(missing_ok=True);raise
        return result
    finally:tmp.unlink(missing_ok=True)
def list_docs(path,q="",trash=False,where="",after=0):
    if not isinstance(q,str) or len(q)>300 or type(after) is not int or after<0:raise ValueError("Некорректный поиск")
    where=folder(where)
    with closing(connect(path)) as db:
        query="SELECT * FROM documents d WHERE deleted IS "+("NOT NULL" if trash else "NULL")+" AND id>?"
        args=[after]
        if where:query+=" AND folder=?";args.append(where)
        terms=sorted(memory.terms(q))
        if terms:
            query+=" AND id IN (SELECT document_id FROM document_terms WHERE term IN ("+",".join("?" for _ in terms)+"))";args+=terms
        elif q.strip():query+=" AND instr(memory_norm(name),?)>0";args.append(memory.norm(q))
        rows=db.execute(query+" ORDER BY id LIMIT 101",args).fetchall()
        stats=db.execute("SELECT COUNT(*),COALESCE(SUM(size),0),SUM(CASE WHEN extract_status='indexed' THEN 1 ELSE 0 END) FROM documents WHERE deleted IS NULL").fetchone()
        folders=[r[0] for r in db.execute("SELECT path FROM document_folders UNION SELECT DISTINCT folder FROM documents WHERE deleted IS NULL AND folder<>'' ORDER BY 1")]
        return {"files":[meta(r) for r in rows[:100]],"next":rows[99]["id"] if len(rows)>100 else None,"folders":folders,"count":stats[0],"bytes":stats[1],"indexed":stats[2] or 0}
def preview(path,ident):
    with closing(connect(path)) as db:
        r=get(db,ident)
        exists=path_for(path,r["blob"]).is_file()
        return {**meta(r),"text":r["content"][:MAX_TEXT],"exists":exists}
def binary(path,ident):
    with closing(connect(path)) as db:
        r=get(db,ident)
        file=path_for(path,r["blob"])
        if not file.is_file() or file.stat().st_size!=r["size"] or r["size"]>MAX_BYTES:raise ValueError("Файл отсутствует или повреждён")
        data=file.read_bytes()
        if hashlib.sha256(data).hexdigest()!=r["sha256"]:raise ValueError("Контрольная сумма не совпадает")
        return r["name"],data
def action(path,data):
    kind=data.get("action")
    with closing(connect(path)) as db,db:
        db.execute("BEGIN IMMEDIATE")
        if kind=="folder":
            where=folder(data.get("folder"))
            if not where:raise ValueError("Укажите папку")
            db.execute("INSERT OR IGNORE INTO document_folders VALUES(?,?)",(where,now()))
            return {"ok":True}
        r=get(db,data.get("id"),False)
        if kind=="trash" and not r["deleted"]:
            db.execute("UPDATE documents SET deleted=? WHERE id=?",(now(),r["id"]))
        elif kind=="restore" and r["deleted"]:
            if not path_for(path,r["blob"]).is_file():raise ValueError("Файл отсутствует")
            db.execute("UPDATE documents SET deleted=NULL WHERE id=?",(r["id"],))
        elif kind=="move" and not r["deleted"]:
            where=folder(data.get("folder"))
            db.execute("UPDATE documents SET folder=? WHERE id=?",(where,r["id"]))
            db.execute("UPDATE nodes SET folder=? WHERE id=?",(where,r["node_id"]))
            db.execute("DELETE FROM document_terms WHERE document_id=?",(r["id"],))
            db.executemany("INSERT OR IGNORE INTO document_terms VALUES(?,?)",((w,r["id"]) for w in memory.terms(r["name"]+" "+where+" "+r["content"]) if len(w)<=80))
        elif kind=="candidates" and not r["deleted"]:
            import cognitive
            before=db.total_changes
            count=0
            for line in r["content"].splitlines()[:1000]:
                match=re.fullmatch(r"\s*(факт|событие|навык|привычка|предпочтение|причина|цель|запомни)\s*[:：]\s*(.+)",line,re.I)
                if match and count<20:
                    k=cognitive.LABELS[match[1].casefold()];title=match[2].strip()
                    if cognitive.safe(title):
                        cognitive.proposal(db,k,title,"document:"+str(r["id"]),cognitive.subject_of(title,k),.5,1);count+=1
            event(db,r["id"],"Кандидаты из документа проверены",r["node_id"])
            return {"ok":True,"scanned":count}
        elif kind=="link" and not r["deleted"]:
            other=data.get("node")
            if type(other) is not int or other<=0 or other==r["node_id"]:raise ValueError("Укажите другую запись")
            if not db.execute("SELECT 1 FROM nodes WHERE id=?",(other,)).fetchone():raise ValueError("Запись не найдена")
            db.execute("INSERT OR IGNORE INTO edges VALUES(?,?)",tuple(sorted((r["node_id"],other))))
        else:raise ValueError("Недопустимая операция")
        event(db,r["id"],{"trash":"Документ в корзине","restore":"Документ восстановлен","move":"Документ перемещён","link":"Связь документа подтверждена"}[kind],r["node_id"])
        return {"ok":True}
def health(path):
    with closing(connect(path)) as db:
        rows=db.execute("SELECT id,blob,size FROM documents").fetchall()
        missing=[]
        for r in rows:
            try:
                f=path_for(path,r["blob"])
                if not f.is_file() or f.stat().st_size!=r["size"]:missing.append(r["id"])
            except (OSError,ValueError):missing.append(r["id"])
        return {"files":len(rows),"missing":missing}

def by_node(path,node):
    with closing(connect(path)) as db:
        row=db.execute("SELECT * FROM documents WHERE node_id=? AND deleted IS NULL",(node,)).fetchone()
        return {"file":meta(row) if row else None}
