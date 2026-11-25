"""Bounded local document intelligence. Suggestions are not verified facts."""
from contextlib import closing, contextmanager
from collections import Counter
from datetime import datetime, timezone
import json
import re
from threading import Thread, Event, Lock
import logging
import documents as doc
import memory_engine as memory

LOCK=Lock()
def init(db):
    db.execute("""CREATE TABLE IF NOT EXISTS document_jobs(document_id INTEGER PRIMARY KEY REFERENCES documents(id),status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,updated TEXT NOT NULL,error TEXT NOT NULL DEFAULT '')""")
    db.execute("CREATE INDEX IF NOT EXISTS document_jobs_status ON document_jobs(status,document_id)")
    db.execute("""CREATE TABLE IF NOT EXISTS document_versions(child INTEGER PRIMARY KEY REFERENCES documents(id),parent INTEGER NOT NULL REFERENCES documents(id),at TEXT NOT NULL,CHECK(child<>parent))""")
    db.execute("CREATE INDEX IF NOT EXISTS document_versions_parent ON document_versions(parent)")
def enqueue(db,ident):
    db.execute("INSERT INTO document_jobs(document_id,status,updated) VALUES(?,'queued',?) ON CONFLICT(document_id) DO UPDATE SET status='queued',updated=excluded.updated,error='',attempts=0",(ident,doc.now()))
def step(path):
    if not LOCK.acquire(False):return False
    try:
        with closing(doc.connect(path)) as db,db:
            db.execute("BEGIN IMMEDIATE")
            row=db.execute("SELECT j.document_id,d.name,d.blob,d.size,d.sha256 FROM document_jobs j JOIN documents d ON d.id=j.document_id WHERE j.status='queued' AND d.deleted IS NULL ORDER BY j.document_id LIMIT 1").fetchone()
            if not row:return False
            ident=row["document_id"]
            db.execute("UPDATE document_jobs SET status='running',attempts=attempts+1,updated=? WHERE document_id=?",(doc.now(),ident))
        try:
            name,raw=doc.binary(path,ident)
            status,content=doc.extract(name,raw)
            with closing(doc.connect(path)) as db,db:
                db.execute("BEGIN IMMEDIATE")
                item=doc.get(db,ident,False)
                if item["deleted"]:
                    db.execute("UPDATE document_jobs SET status='queued',updated=? WHERE document_id=?",(doc.now(),ident))
                    return True
                db.execute("UPDATE documents SET extract_status=?,content=? WHERE id=?",(status,content,ident))
                db.execute("DELETE FROM document_terms WHERE document_id=?",(ident,))
                db.executemany("INSERT OR IGNORE INTO document_terms VALUES(?,?)",((w,ident) for w in memory.terms(name+" "+item["folder"]+" "+content) if len(w)<=80))
                db.execute("UPDATE document_jobs SET status=?,updated=?,error=? WHERE document_id=?",("failed" if status in ("extraction_failed","unsupported_encoding") else "done",doc.now(),status if status in ("extraction_failed","unsupported_encoding") else "",ident))
                doc.event(db,ident,"Индексация: "+status,item["node_id"])
        except Exception:
            logging.exception("Document indexing failed")
            with closing(doc.connect(path)) as db,db:
                db.execute("UPDATE document_jobs SET status='failed',updated=?,error='Файл недоступен или ошибка обработки' WHERE document_id=?",(doc.now(),ident))
        return True
    finally:LOCK.release()
@contextmanager
def worker(path):
    with closing(doc.connect(path)) as db,db:
        db.execute("UPDATE document_jobs SET status='queued' WHERE status='running'")
    stop=Event()
    def run():
        while not stop.is_set():
            try:step(path)
            except Exception:logging.exception("Document worker failure")
            stop.wait(2)
    thread=Thread(target=run,daemon=True,name="document-index")
    thread.start()
    try:yield
    finally:stop.set();thread.join(timeout=5)
def words(text):
    return [w for w in re.findall(r"\w{3,}",memory.norm(text)) if w not in memory.STOP]
def tags(text):
    return [w for w,_ in Counter(words(text)).most_common(10)]
def graph(path,after=0):
    if type(after) is not int or after<0:raise ValueError("Invalid cursor")
    with closing(doc.connect(path)) as db:
        db.execute("BEGIN")
        rows=db.execute("SELECT id,node_id,name,folder,size,extract_status FROM documents WHERE deleted IS NULL AND id>? ORDER BY id LIMIT 201",(after,)).fetchall()
        more=len(rows)>200;rows=rows[:200];ids=[r["node_id"] for r in rows];links=[]
        if ids:
            marks=",".join("?" for _ in ids)
            for row in db.execute("SELECT source,target FROM edges WHERE source IN ("+marks+") AND target IN ("+marks+") ORDER BY source,target LIMIT 3000",ids+ids):
                links.append({"source":row[0],"target":row[1]})
        # Degree includes real external memory links, excluding trashed documents.
        nodes=[]
        for r in rows:
            degree=db.execute("""SELECT COUNT(*) FROM edges e WHERE (source=? OR target=?) AND NOT EXISTS(SELECT 1 FROM documents d WHERE d.deleted IS NOT NULL AND d.node_id IN(e.source,e.target))""",(r["node_id"],r["node_id"])).fetchone()[0]
            nodes.append({**dict(r),"degree":degree})
        versions=[]
        if rows:
            keys=[r["id"] for r in rows];marks=",".join("?" for _ in keys)
            versions=[dict(r) for r in db.execute("SELECT child,parent FROM document_versions WHERE child IN ("+marks+") AND parent IN ("+marks+")",keys+keys)]
        return {"nodes":nodes,"edges":links,"versions":versions,"next":rows[-1]["id"] if more else None,"total":db.execute("SELECT COUNT(*) FROM documents WHERE deleted IS NULL").fetchone()[0]}
def details(path,ident):
    with closing(doc.connect(path)) as db:
        r=doc.get(db,ident)
        q=tags(r["content"])
        candidates=[]
        if q:
            marks=",".join("?" for _ in q)
            rows=db.execute("SELECT d.id,d.name,d.node_id,d.folder,COUNT(*) overlap FROM document_terms t JOIN documents d ON d.id=t.document_id WHERE d.deleted IS NULL AND d.id<>? AND t.term IN ("+marks+") GROUP BY d.id ORDER BY overlap DESC,d.id LIMIT 20",[ident]+q)
            for other in rows:
                candidates.append({**dict(other),"score":round(other["overlap"]/len(q),3)})
        links=[dict(x) for x in db.execute("""SELECT n.id,n.title,n.category FROM edges e JOIN nodes n ON n.id=CASE WHEN e.source=? THEN e.target ELSE e.source END WHERE (e.source=? OR e.target=?) AND NOT EXISTS(SELECT 1 FROM documents d WHERE d.node_id=n.id AND d.deleted IS NOT NULL) ORDER BY n.id LIMIT 100""",(r["node_id"],r["node_id"],r["node_id"]))]
        source="document:"+str(ident)
        candidates_memory=[dict(x) for x in db.execute("SELECT id,title,kind,state FROM cog_candidates WHERE source=? ORDER BY id DESC LIMIT 50",(source,))]
        memories=[dict(x) for x in db.execute("SELECT n.id,n.title,m.kind FROM cog_memory m JOIN nodes n ON n.id=m.node_id WHERE m.source=? AND m.node_id<>? ORDER BY n.id LIMIT 50",(source,r["node_id"]))]
        versions=[dict(x) for x in db.execute("SELECT v.child,v.parent,p.name parent_name,c.name child_name FROM document_versions v JOIN documents p ON p.id=v.parent JOIN documents c ON c.id=v.child WHERE v.parent=? OR v.child=? ORDER BY v.child LIMIT 50",(ident,ident))]
        job=db.execute("SELECT status,attempts,error,updated FROM document_jobs WHERE document_id=?",(ident,)).fetchone()
        # structured claims are compared only when explicit labels exist
        claims={}
        for line in r["content"].splitlines()[:2000]:
            m=re.fullmatch(r"\s*факт\s*:\s*([^=:]{1,80})\s*[=:]\s*(.{1,120})",line,re.I)
            if m:claims.setdefault(memory.norm(m[1]),set()).add(memory.norm(m[2]))
        evidence=[]
        for subject,values in list(claims.items())[:20]:
            if len(values)>1:evidence.append({"subject":subject,"document":ident,"kind":"внутреннее расхождение","values":sorted(values)})
            for other in candidates[:8]:
                row=db.execute("SELECT content FROM documents WHERE id=?",(other["id"],)).fetchone()
                if not row:continue
                for line in row[0].splitlines()[:2000]:
                    m=re.fullmatch(r"\s*факт\s*:\s*([^=:]{1,80})\s*[=:]\s*(.{1,120})",line,re.I)
                    if m and memory.norm(m[1])==subject:
                        value=memory.norm(m[2])
                        evidence.append({"subject":subject,"document":other["id"],"kind":"совпадение" if value in values else "возможное противоречие","values":[value]})
                        break
        return {"tags":q,"suggestions":candidates,"links":links,"candidates":candidates_memory,"memories":memories,"versions":versions,"job":dict(job) if job else None,"evidence":evidence[:40],"words":len(words(r["content"])),"characters":len(r["content"]),"folder_hint":candidates[0]["folder"] if candidates and candidates[0]["score"]>=.3 else ""}
def mutate(path,data):
    action=data.get("action")
    ident=data.get("id")
    if action=="batch":
        ids=data.get("ids")
        if not isinstance(ids,list) or not 1<=len(ids)<=100 or any(type(i) is not int for i in ids) or len(set(ids))!=len(ids):raise ValueError("Invalid selection")
        mode=data.get("mode")
        if mode not in ("trash","move","restore"):raise ValueError("Invalid batch operation")
        # Individual transactions, report partial failures rather than claiming atomicity.
        results=[]
        for i in ids:
            try:doc.action(path,{"action":mode,"id":i,"folder":data.get("folder","")});results.append({"id":i,"ok":True})
            except (ValueError,OSError):results.append({"id":i,"ok":False})
        return {"results":results}
    with closing(doc.connect(path)) as db,db:
        db.execute("BEGIN IMMEDIATE")
        r=doc.get(db,ident)
        if action=="reindex":
            job=db.execute("SELECT status FROM document_jobs WHERE document_id=?",(ident,)).fetchone()
            if job and job[0]=="running":raise ValueError("Индексация уже выполняется")
            enqueue(db,ident)
        elif action=="version":
            parent=data.get("parent")
            p=doc.get(db,parent)
            if parent==ident:raise ValueError("Выберите другой документ")
            if db.execute("WITH RECURSIVE chain(id) AS (SELECT ? UNION SELECT v.parent FROM document_versions v JOIN chain c ON v.child=c.id) SELECT 1 FROM chain WHERE id=?",(parent,ident)).fetchone():raise ValueError("Цикл редакций")
            if db.execute("SELECT 1 FROM document_versions WHERE child=?",(ident,)).fetchone():raise ValueError("Предыдущая редакция уже установлена")
            db.execute("INSERT INTO document_versions VALUES(?,?,?)",(ident,parent,doc.now()))
            db.execute("INSERT OR IGNORE INTO edges VALUES(?,?)",tuple(sorted((r["node_id"],p["node_id"]))))
            doc.event(db,ident,"Установлена предыдущая редакция",r["node_id"])
        else:raise ValueError("Unknown action")
    return {"ok":True}
def excerpts(path,query,ident=None):
    if not isinstance(query,str) or not query.strip() or len(query)>300:raise ValueError("Укажите вопрос до 300 символов")
    terms=memory.terms(query)
    if not terms:return {"sources":[]}
    with closing(doc.connect(path)) as db:
        if ident is not None: rows=[doc.get(db,ident)]
        else:
            marks=",".join("?" for _ in terms)
            rows=db.execute("SELECT d.* FROM documents d JOIN (SELECT document_id,COUNT(*) hits FROM document_terms WHERE term IN ("+marks+") GROUP BY document_id ORDER BY hits DESC LIMIT 30) t ON d.id=t.document_id WHERE d.deleted IS NULL ORDER BY t.hits DESC,d.id",tuple(sorted(terms))).fetchall()
        result=[]
        for row in rows:
            # Preserve exact source fragments; no synthetic answer or cloud requests.
            best=[]
            for line in row["content"].splitlines()[:4000]:
                for i in range(0,min(len(line),200000),600):
                    piece=line[i:i+600].strip()
                    score=len(terms & memory.terms(piece))
                    if score:best.append((score,piece))
            if best:
                best.sort(key=lambda x:-x[0]);result.append({"id":row["id"],"name":row["name"],"excerpt":best[0][1],"matches":best[0][0]})
        result.sort(key=lambda x:-x["matches"])
        return {"sources":result[:8]}
def analytics(path):
    with closing(doc.connect(path)) as db:
        stats=dict(db.execute("""SELECT COUNT(*) count,COALESCE(SUM(size),0) bytes,SUM(extract_status='indexed') indexed,SUM(extract_status='preview_only') preview_only FROM documents WHERE deleted IS NULL""").fetchone())
        formats=Counter();volumes=Counter()
        for row in db.execute("SELECT name,size FROM documents WHERE deleted IS NULL"):
            ext=row[0].rsplit(".",1)[-1].lower();formats[ext]+=1;volumes[ext]+=row[1]
        days=[dict(r) for r in db.execute("SELECT substr(created,1,10) day,COUNT(*) count FROM documents WHERE deleted IS NULL GROUP BY day ORDER BY day DESC LIMIT 30")]
        jobs={r[0]:r[1] for r in db.execute("SELECT j.status,COUNT(*) FROM document_jobs j JOIN documents d ON d.id=j.document_id WHERE d.deleted IS NULL GROUP BY j.status")}
        isolated=db.execute("SELECT COUNT(*) FROM documents d WHERE d.deleted IS NULL AND NOT EXISTS(SELECT 1 FROM edges e WHERE (e.source=d.node_id OR e.target=d.node_id) AND NOT EXISTS(SELECT 1 FROM documents x WHERE x.deleted IS NOT NULL AND x.node_id IN(e.source,e.target)))").fetchone()[0]
        knowledge=db.execute("SELECT COUNT(*) FROM cog_memory m JOIN documents d ON m.source='document:'||d.id WHERE m.node_id<>d.node_id AND d.deleted IS NULL").fetchone()[0]
        return {**stats,"formats":[{"format":k,"count":v,"bytes":volumes[k]} for k,v in formats.most_common()],"days":days,"jobs":jobs,"isolated":isolated,"knowledge":knowledge,"versions":db.execute("SELECT COUNT(*) FROM document_versions").fetchone()[0],"events":[dict(r) for r in db.execute("SELECT at,kind,document_id FROM document_events ORDER BY id DESC LIMIT 20")]}
