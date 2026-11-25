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
import document_intelligence as intelligence

LOCK=Lock()
def init(db):
    db.execute("""CREATE TABLE IF NOT EXISTS document_jobs(document_id INTEGER PRIMARY KEY REFERENCES documents(id),status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,updated TEXT NOT NULL,error TEXT NOT NULL DEFAULT '')""")
    db.execute("CREATE INDEX IF NOT EXISTS document_jobs_status ON document_jobs(status,document_id)")
    db.execute("""CREATE TABLE IF NOT EXISTS document_versions(child INTEGER PRIMARY KEY REFERENCES documents(id),parent INTEGER NOT NULL REFERENCES documents(id),at TEXT NOT NULL,CHECK(child<>parent))""")
    db.execute("CREATE INDEX IF NOT EXISTS document_versions_parent ON document_versions(parent)")
def enqueue(db,ident):
    db.execute("INSERT INTO document_jobs(document_id,status,updated) VALUES(?,'queued',?) ON CONFLICT(document_id) DO UPDATE SET status='queued',updated=excluded.updated,error=''",(ident,doc.now()))
def step(path):
    if not LOCK.acquire(False):return False
    try:
        with closing(doc.connect(path)) as db,db:
            db.execute("BEGIN IMMEDIATE")
            row=db.execute("SELECT j.document_id,d.name,d.blob,d.size,d.sha256 FROM document_jobs j JOIN documents d ON d.id=j.document_id WHERE j.status='queued' AND d.deleted IS NULL ORDER BY j.document_id LIMIT 1").fetchone()
            if not row:return intelligence.backfill_one(db)
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
                if status=="indexed":intelligence.index_document(db,ident)
                db.execute("UPDATE document_jobs SET status=?,updated=?,error=? WHERE document_id=?",("failed" if status in ("extraction_failed","unsupported_encoding") else "done",doc.now(),status if status in ("extraction_failed","unsupported_encoding") else "",ident))
                doc.event(db,ident,"Индексация: "+status,item["node_id"])
        except Exception:
            logging.exception("Document indexing failed")
            with closing(doc.connect(path)) as db,db:
                item=doc.get(db,ident,False)
                if item["deleted"]:
                    db.execute("UPDATE document_jobs SET status='queued',updated=?,error='' WHERE document_id=?",(doc.now(),ident))
                else:
                    db.execute("UPDATE document_jobs SET status='failed',updated=?,error='Файл недоступен или ошибка обработки' WHERE document_id=?",(doc.now(),ident))
                    db.execute("UPDATE documents SET extract_status='extraction_failed',content='' WHERE id=?",(ident,))
                    db.execute("DELETE FROM document_terms WHERE document_id=?",(ident,))
                    db.executemany("INSERT OR IGNORE INTO document_terms VALUES(?,?)",((t,ident) for t in memory.terms(item["name"]+" "+item["folder"]) if len(t)<=80))
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
def graph(path,after=0,query="",where="",trash=False):
    if type(after) is not int or after<0 or not isinstance(query,str) or len(query)>300:raise ValueError("Invalid cursor or query")
    where=doc.folder(where)
    with closing(doc.connect(path)) as db:
        db.execute("BEGIN")
        criteria="deleted IS "+("NOT NULL" if trash else "NULL")
        args=[]
        if where:
            criteria+=" AND (folder=? OR substr(folder,1,length(?)+1)=?||'/')";args.extend([where,where,where])
        terms=sorted(memory.terms(query))
        if terms:
            criteria+=" AND (id IN (SELECT document_id FROM document_terms WHERE term IN ("+",".join("?" for _ in terms)+")) OR instr(memory_norm(name),?)>0)";args+=terms+[memory.norm(query)]
        elif query.strip():
            criteria+=" AND instr(memory_norm(name),?)>0";args.append(memory.norm(query))
        rows=db.execute("SELECT id,node_id,name,folder,size,extract_status FROM documents WHERE "+criteria+" AND id>? ORDER BY id LIMIT 201",args+[after]).fetchall()
        more=len(rows)>200;rows=rows[:200];ids=[r["node_id"] for r in rows];links=[];degrees=Counter();outside=Counter();versions=[]
        if ids and not trash:
            marks=",".join("?" for _ in ids)
            active="NOT EXISTS(SELECT 1 FROM documents d WHERE d.deleted IS NOT NULL AND d.node_id IN(e.source,e.target))"
            for row in db.execute("SELECT e.source,e.target FROM edges e WHERE (e.source IN ("+marks+") OR e.target IN ("+marks+")) AND "+active,ids+ids):
                a,b=row;degrees[a]+=1;degrees[b]+=1
                if a in ids and b in ids:
                    if len(links)<3000:links.append({"source":a,"target":b})
                else:
                    if a in ids:outside[a]+=1
                    if b in ids:outside[b]+=1
            keys=[r["id"] for r in rows];marks=",".join("?" for _ in keys)
            versions=[dict(r) for r in db.execute("SELECT child,parent FROM document_versions WHERE child IN ("+marks+") AND parent IN ("+marks+")",keys+keys)]
        grouping=clusters(db,rows) if not trash else {}
        return {"nodes":[{**dict(r),"degree":degrees[r["node_id"]],"outside":outside[r["node_id"]],**grouping.get(r["id"],{})} for r in rows],"edges":links,"versions":versions,"next":rows[-1]["id"] if more else None,"total":db.execute("SELECT COUNT(*) FROM documents WHERE "+criteria,args).fetchone()[0],"revision":db.execute("SELECT version FROM atlas_revision WHERE id=1").fetchone()[0]}
def details(path,ident):
    with closing(doc.connect(path)) as db:
        db.execute("BEGIN")
        r=doc.get(db,ident)
        q=tags(r["content"]) if r["extract_status"]=="indexed" else []
        candidates=intelligence.related(db,r)
        links=[dict(x) for x in db.execute("""SELECT n.id,n.title,n.category FROM edges e JOIN nodes n ON n.id=CASE WHEN e.source=? THEN e.target ELSE e.source END WHERE (e.source=? OR e.target=?) AND NOT EXISTS(SELECT 1 FROM documents d WHERE d.node_id=n.id AND d.deleted IS NOT NULL) ORDER BY n.id LIMIT 100""",(r["node_id"],r["node_id"],r["node_id"]))]
        candidates_memory=[dict(x) for x in db.execute("SELECT c.id,c.title,c.kind,c.state FROM cog_candidates c JOIN document_sources s ON s.fingerprint=c.fingerprint WHERE s.document_id=? ORDER BY c.id DESC LIMIT 50",(ident,))]
        memories=[dict(x) for x in db.execute("SELECT DISTINCT n.id,n.title,m.kind FROM document_sources s JOIN nodes n ON n.id=s.node_id JOIN cog_memory m ON m.node_id=n.id WHERE s.document_id=? ORDER BY n.id LIMIT 50",(ident,))]
        linked_ids={x["id"] for x in links}
        versions=[dict(x) for x in db.execute("SELECT v.child,v.parent,p.name parent_name,c.name child_name FROM document_versions v JOIN documents p ON p.id=v.parent JOIN documents c ON c.id=v.child WHERE v.parent=? OR v.child=? ORDER BY v.child LIMIT 50",(ident,ident))]
        job=db.execute("SELECT status,attempts,error,updated FROM document_jobs WHERE document_id=?",(ident,)).fetchone()
        evidence=intelligence.conflicts(db,r)
        classification=intelligence.classification_state(db,r)
        return {"tags":q,"suggestions":[c for c in candidates if c["node_id"] not in linked_ids],"links":links,"candidates":candidates_memory,"memories":memories,"versions":versions,"job":dict(job) if job else None,"evidence":evidence,"words":len(words(r["content"])),"characters":len(r["content"]),"folder_hint":candidates[0]["folder"] if candidates and candidates[0]["score"]>=.3 else "","classification":classification,"provenance":intelligence.provenance(db,r),"fragments":db.execute("SELECT fragment_count FROM doc_fragment_state WHERE document_id=?",(ident,)).fetchone()[0] if db.execute("SELECT 1 FROM doc_fragment_state WHERE document_id=?",(ident,)).fetchone() else 0,"fragment_pending":intelligence.pending(db)}

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
            db.execute("UPDATE documents SET extract_status='queued',content='' WHERE id=?",(ident,))
            db.execute("DELETE FROM document_terms WHERE document_id=?",(ident,))
            db.executemany("INSERT OR IGNORE INTO document_terms VALUES(?,?)",((t,ident) for t in memory.terms(r["name"]+" "+r["folder"]) if len(t)<=80))
        elif action=="version":
            parent=data.get("parent")
            p=doc.get(db,parent)
            if parent==ident:raise ValueError("Выберите другой документ")
            if db.execute("WITH RECURSIVE chain(id) AS (SELECT ? UNION SELECT v.parent FROM document_versions v JOIN chain c ON v.child=c.id) SELECT 1 FROM chain WHERE id=?",(parent,ident)).fetchone():raise ValueError("Цикл редакций")
            if db.execute("SELECT 1 FROM document_versions WHERE child=?",(ident,)).fetchone():raise ValueError("Предыдущая редакция уже установлена")
            db.execute("INSERT INTO document_versions VALUES(?,?,?)",(ident,parent,doc.now()))
            db.execute("INSERT OR IGNORE INTO edges VALUES(?,?)",tuple(sorted((r["node_id"],p["node_id"]))))
            db.execute("INSERT INTO cog_goals(code,title) VALUES(?,?) ON CONFLICT(code) DO UPDATE SET state=\x27suggested\x27",("document-version:"+str(ident),"Проверить знания предыдущей редакции #"+str(parent)))
            doc.event(db,ident,"Установлена предыдущая редакция",r["node_id"])
        else:raise ValueError("Unknown action")
    return {"ok":True}
def excerpts(path,query,ident=None):
    return intelligence.search(path,query,ident)
def analytics(path):
    with closing(doc.connect(path)) as db:
        db.execute("BEGIN")
        stats=dict(db.execute("""SELECT COUNT(*) count,COALESCE(SUM(size),0) bytes,COALESCE(SUM(extract_status='indexed'),0) AS "indexed",COALESCE(SUM(extract_status='preview_only'),0) AS preview_only FROM documents WHERE deleted IS NULL""").fetchone())
        formats=Counter();volumes=Counter()
        for row in db.execute("SELECT name,size FROM documents WHERE deleted IS NULL"):
            ext=row[0].rsplit(".",1)[-1].lower();formats[ext]+=1;volumes[ext]+=row[1]
        days=[dict(r) for r in db.execute("SELECT substr(created,1,10) day,COUNT(*) count FROM documents WHERE deleted IS NULL GROUP BY day ORDER BY day DESC LIMIT 30")]
        jobs={r[0]:r[1] for r in db.execute("SELECT j.status,COUNT(*) FROM document_jobs j JOIN documents d ON d.id=j.document_id WHERE d.deleted IS NULL GROUP BY j.status")}
        isolated=db.execute("SELECT COUNT(*) FROM documents d WHERE d.deleted IS NULL AND NOT EXISTS(SELECT 1 FROM edges e WHERE (e.source=d.node_id OR e.target=d.node_id) AND NOT EXISTS(SELECT 1 FROM documents x WHERE x.deleted IS NOT NULL AND x.node_id IN(e.source,e.target)))").fetchone()[0]
        knowledge=db.execute("SELECT COUNT(DISTINCT s.node_id) FROM document_sources s JOIN documents d ON s.document_id=d.id WHERE d.deleted IS NULL AND s.node_id IS NOT NULL").fetchone()[0]
        return {**stats,"physical_bytes":db.execute("SELECT COALESCE(SUM(size),0) FROM documents").fetchone()[0],"formats":[{"format":k,"count":v,"bytes":volumes[k]} for k,v in formats.most_common()],"days":days,"jobs":jobs,"isolated":isolated,"knowledge":knowledge,"versions":db.execute("SELECT COUNT(*) FROM document_versions").fetchone()[0],"events":[dict(r) for r in db.execute("SELECT at,kind,document_id FROM document_events ORDER BY id DESC LIMIT 20")]}

def revision(path):
    with closing(doc.connect(path)) as db:
        return {"revision":db.execute("SELECT version FROM atlas_revision WHERE id=1").fetchone()[0]}
def quality(path):
    with closing(doc.connect(path)) as db:
        db.execute("BEGIN")
        wrong_index=[];wrong_metadata=[];missing_edges=[]
        for row in db.execute("SELECT d.id,d.name,d.folder,d.content,d.extract_status,n.title,n.folder node_folder FROM documents d JOIN nodes n ON n.id=d.node_id"):
            expected={t for t in memory.terms(row["name"]+" "+row["folder"]+" "+(row["content"] if row["extract_status"]=="indexed" else "")) if len(t)<=80}
            actual={r[0] for r in db.execute("SELECT term FROM document_terms WHERE document_id=?",(row["id"],))}
            if actual!=expected:wrong_index.append(row["id"])
            if row["name"]!=row["title"] or row["folder"]!=row["node_folder"]:wrong_metadata.append(row["id"])
        for row in db.execute("SELECT s.node_id,d.node_id FROM document_sources s JOIN documents d ON d.id=s.document_id WHERE s.node_id IS NOT NULL AND s.node_id<>d.node_id"):
            if not db.execute("SELECT 1 FROM edges WHERE source=? AND target=?",tuple(sorted(row))).fetchone():missing_edges.append(list(row))
        return {"foreign_keys":sum(1 for _ in db.execute("PRAGMA foreign_key_check")),"index_mismatch":wrong_index,"metadata_mismatch":wrong_metadata,"source_edges_missing":missing_edges,"fragment_pending":intelligence.pending(db)}


def clusters(db,rows):
    """Bounded groups for the current graph page; cached embeddings only."""
    if not rows:return {}
    ids=[r["id"] for r in rows]
    marks=",".join("?" for _ in ids)
    texts={r["id"]:r["content"] for r in db.execute("SELECT id,CASE WHEN extract_status='indexed' THEN substr(content,1,12000) ELSE '' END content FROM documents WHERE id IN ("+marks+")",ids)}
    vectors={}
    if memory.table(db,"embedding_cache"):
        import gateway
        for r in rows:
            # Existing cache uses exact node titles; never request fresh embeddings.
            hit=db.execute("SELECT vector FROM embedding_cache WHERE model=? AND digest=?",(gateway.EMBED_MODEL,memory.digest(r["name"]))).fetchone()
            if hit:
                try:
                    v=memory.vector(json.loads(hit[0]))
                    if len(v)<=2048:vectors[r["id"]]=v
                except (ValueError,TypeError):pass
    reps=[];groups={}
    for r in rows:
        ident=r["id"]
        keys=set(tags(texts[ident])) if texts[ident] else set()
        vec=vectors.get(ident)
        best=None;best_score=0
        for rep,other,other_vec,label in reps:
            lexical=len(keys&other)/max(1,len(keys|other)) if len(keys&other)>=2 else 0
            semantic=memory.cosine(vec,other_vec) if vec and other_vec and len(vec)==len(other_vec) else 0
            score=max(lexical if lexical>=.25 else 0,semantic if semantic>=.84 else 0)
            if score>best_score:best=(rep,label,"cached_title_embedding" if semantic>=.84 and semantic>=lexical else "keywords");best_score=score
        if best:
            groups[ident]={"cluster":best[0],"cluster_label":best[1],"cluster_method":best[2]}
        elif len(reps)<32 and (keys or vec):
            label=" / ".join(tags(texts[ident])[:3]) or r["name"]
            reps.append((ident,keys,vec,label))
            groups[ident]={"cluster":ident,"cluster_label":label,"cluster_method":"representative"}
        else:
            groups[ident]={"cluster":0,"cluster_label":"Без группы","cluster_method":"none"}
    return groups

def history(path,ident):
    with closing(doc.connect(path)) as db:
        db.execute("BEGIN")
        r=doc.get(db,ident,False)
        events=[dict(x) for x in db.execute("""SELECT at,kind FROM (SELECT id,at,kind FROM document_event_archive WHERE document_id=? UNION SELECT id,at,kind FROM document_events WHERE document_id=?) ORDER BY id DESC LIMIT 200""",(ident,ident))]
        sources=[dict(x) for x in db.execute("""SELECT s.fingerprint,s.node_id,c.state,c.at candidate_at,m.at memory_at,COALESCE(n.title,c.title,'') title FROM document_sources s LEFT JOIN cog_candidates c ON c.fingerprint=s.fingerprint LEFT JOIN cog_memory m ON m.node_id=s.node_id LEFT JOIN nodes n ON n.id=s.node_id WHERE s.document_id=? ORDER BY s.fingerprint LIMIT 200""",(ident,))]
        return {"id":ident,"events":events,"sources":sources,"limit":200,"historical_complete":False}

def rebuild_sources(path):
    """Rebuild only explicitly recorded document origins; never infer past events."""
    with closing(doc.connect(path)) as db,db:
        db.execute("BEGIN IMMEDIATE")
        before=db.execute("SELECT COUNT(*) FROM document_sources").fetchone()[0]
        db.execute("INSERT OR IGNORE INTO document_sources SELECT c.fingerprint,d.id,NULL FROM cog_candidates c JOIN documents d ON c.source='document:'||d.id")
        db.execute("INSERT OR IGNORE INTO document_sources SELECT m.fingerprint,d.id,m.node_id FROM cog_memory m JOIN documents d ON m.source='document:'||d.id WHERE m.node_id<>d.node_id")
        # A unique fingerprint plus an explicit source is evidence; ambiguous matches stay unresolved.
        updated=db.execute("""UPDATE document_sources SET node_id=(SELECT MIN(m.node_id) FROM cog_memory m WHERE m.fingerprint=document_sources.fingerprint) WHERE node_id IS NULL AND (SELECT COUNT(*) FROM cog_memory m WHERE m.fingerprint=document_sources.fingerprint)=1 AND EXISTS(SELECT 1 FROM cog_candidates c WHERE c.fingerprint=document_sources.fingerprint AND c.state='approved')""").rowcount
        links=0
        for source in db.execute("""SELECT DISTINCT d.node_id,s.node_id FROM document_sources s JOIN documents d ON d.id=s.document_id JOIN nodes n ON n.id=s.node_id WHERE d.deleted IS NULL AND d.extract_status='indexed' AND d.node_id<>s.node_id AND NOT EXISTS(SELECT 1 FROM cog_candidates c WHERE c.fingerprint=s.fingerprint AND c.state='rejected') AND NOT EXISTS(SELECT 1 FROM documents x WHERE x.node_id=s.node_id AND x.deleted IS NOT NULL)""").fetchall():
            links+=db.execute("INSERT OR IGNORE INTO edges VALUES(?,?)",tuple(sorted(source))).rowcount
        after=db.execute("SELECT COUNT(*) FROM document_sources").fetchone()[0]
        return {"added":after-before,"resolved":updated,"links":links,"unresolved":db.execute("SELECT COUNT(*) FROM document_sources WHERE node_id IS NULL").fetchone()[0],"historical_complete":False}
