"""Evidence-based local memory evolution; no network or model training."""
from contextlib import closing
from datetime import datetime, timezone, timedelta
import json
import re
import sqlite3
import memory_engine as memory

MODEL="Qwen/Qwen3-Embedding-0.6B"
def now(): return datetime.now(timezone.utc).isoformat()
def init(db):
    if memory.table(db,"evo_versions") and memory.table(db,"evo_journal_archive"): return
    db.executescript("""
    CREATE TABLE IF NOT EXISTS evo_versions(id INTEGER PRIMARY KEY,node_id INTEGER NOT NULL REFERENCES nodes(id),at TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('current','historical','unverified')),note TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS evo_versions_node ON evo_versions(node_id,id);
    CREATE TABLE IF NOT EXISTS evo_review(node_id INTEGER PRIMARY KEY REFERENCES nodes(id),checked TEXT NOT NULL,days INTEGER NOT NULL CHECK(days BETWEEN 1 AND 3650));
    CREATE TABLE IF NOT EXISTS evo_digest(id INTEGER PRIMARY KEY,at TEXT NOT NULL,title TEXT NOT NULL,source_ids TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS evo_journal(id INTEGER PRIMARY KEY,at TEXT NOT NULL,kind TEXT NOT NULL,detail TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS evo_journal_kind ON evo_journal(kind,id);
    CREATE TABLE IF NOT EXISTS evo_journal_archive(id INTEGER PRIMARY KEY,at TEXT NOT NULL,kind TEXT NOT NULL,detail TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS cog_alias_canonical ON cog_aliases(canonical_id);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
    """)
def connect(path):
    db=sqlite3.connect(path,timeout=5)
    db.row_factory=sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    init(db)
    return db
def log(db,kind,detail):
    db.execute("INSERT INTO evo_journal(at,kind,detail) VALUES(?,?,?)",(now(),kind,detail))
    cutoff=db.execute("SELECT MAX(id)-5000 FROM evo_journal").fetchone()[0]
    if cutoff>0:
        db.execute("INSERT OR IGNORE INTO evo_journal_archive SELECT * FROM evo_journal WHERE id<=?",(cutoff,))
        db.execute("DELETE FROM evo_journal WHERE id<=?",(cutoff,))
def record(db,node):
    row=db.execute("SELECT n.id,n.title,n.category,n.folder,n.created_at,m.kind,m.subject,m.source,m.confidence FROM nodes n LEFT JOIN cog_memory m ON m.node_id=n.id WHERE n.id=?",(node,)).fetchone()
    return dict(row) if row else None
def neighbors(db,ids,limit=24):
    seen={memory.canonical(db,i) for i in ids};result=[]
    for ident in ids[:8]:
        root=memory.canonical(db,ident)
        rows=db.execute("""WITH members(id) AS (SELECT ? UNION SELECT alias_id FROM cog_aliases WHERE canonical_id=?)
            SELECT target FROM edges JOIN members ON source=members.id UNION SELECT source FROM edges JOIN members ON target=members.id LIMIT 128""",(root,root))
        for row in rows:
            target=memory.canonical(db,row[0])
            if target in seen:continue
            seen.add(target)
            item=record(db,target)
            if item:result.append({**item,"via":root})
            if len(result)>=limit:return result
    return result
current_state=memory.current_state
def freshness(db,node):
    row=db.execute("SELECT checked,days FROM evo_review WHERE node_id=?",(node,)).fetchone()
    if not row:return "unreviewed"
    return "review_due" if datetime.fromisoformat(row[0])+timedelta(days=row[1])<=datetime.now(timezone.utc) else "reviewed"
def retrieve(db,q,active_only=False):
    # The existing global hybrid engine is the only primary retrieval algorithm.
    seeds=memory.search(db,q,MODEL,limit=8,active_only=active_only)
    for r in seeds:
        r["state"]=current_state(db,r["id"])
        r["freshness"]=freshness(db,r["id"])
    # Historical facts are preserved, not silently treated as current.
    seeds.sort(key=lambda r:(r["state"]!="historical",r["score"]),reverse=True)
    linked=neighbors(db,[r["id"] for r in seeds])
    for r in linked:
        r["state"]=current_state(db,r["id"]);r["freshness"]=freshness(db,r["id"])
    if active_only:linked=[r for r in linked if r["state"]!="historical"]
    skills=[r for r in seeds+linked if r["category"] in ("Навыки","Опыт") and r["state"]!="historical" and r["freshness"]!="review_due"]
    summaries=[]
    qterms=memory.terms(q)
    for row in db.execute("SELECT id,title,source_ids FROM evo_digest ORDER BY id DESC LIMIT 1000"):
        if qterms & memory.terms(row["title"]):
            summaries.append(dict(row))
            if len(summaries)>=5:break
    return {"seeds":seeds,"linked":linked,"summaries":summaries,"experience":skills[:8],"stages":[{"name":"Гибридный поиск","count":len(seeds)},{"name":"Связанные записи","count":len(linked)},{"name":"Опыт и навыки","count":min(8,len(skills))}],"method":"cached_vectors_and_words; linked records are context, not proof"}
def explore(path,data):
    q=data.get("query")
    if not isinstance(q,str) or not 1<=len(q.strip())<=300:raise ValueError("Введите запрос до 300 символов")
    with closing(connect(path)) as db,db:
        result=retrieve(db,q)
        log(db,"retrieve","Поиск: %d основных, %d связанных"%(len(result["seeds"]),len(result["linked"])))
        for item in result["seeds"][:8]:
            db.execute("INSERT INTO cog_events(at,kind,detail,node_id) VALUES(?,?,?,?)",(now(),"recall","Многоуровневый поиск",item["id"]))
        for item in result["seeds"]:
            db.execute("UPDATE cog_memory SET recall_count=recall_count+1 WHERE node_id=?",(item["id"],))
        return result
def conflict_rows(db,limit=40):
    # Same normalized subject + different normalized statements => possible conflict, not a verdict.
    rows=db.execute("""SELECT a.node_id source,b.node_id target, a.subject,n.title source_title,p.title target_title
      FROM cog_memory a JOIN cog_memory b ON a.subject=b.subject AND a.node_id<b.node_id
      JOIN nodes n ON n.id=a.node_id JOIN nodes p ON p.id=b.node_id
      WHERE a.subject<>'' AND a.fingerprint<>b.fingerprint
      AND NOT EXISTS(SELECT 1 FROM cog_aliases x WHERE x.alias_id IN (a.node_id,b.node_id))
      AND COALESCE((SELECT state FROM evo_versions WHERE node_id=a.node_id ORDER BY id DESC LIMIT 1),'unverified')<>'historical'
      AND COALESCE((SELECT state FROM evo_versions WHERE node_id=b.node_id ORDER BY id DESC LIMIT 1),'unverified')<>'historical'
      ORDER BY a.node_id DESC,b.node_id LIMIT ?""",(limit,))
    return [dict(r) for r in rows]
def fact_state(path,data):
    node,state,note=data.get("id"),data.get("state"),data.get("note","")
    if type(node) is not int or state not in ("current","historical","unverified") or not isinstance(note,str) or len(note)>160:raise ValueError("Invalid fact revision")
    with closing(connect(path)) as db,db:
        db.execute("BEGIN IMMEDIATE")
        node=memory.canonical(db,node)
        item=record(db,node)
        if not item:raise ValueError("Unknown record")
        subject=memory.subject(item["title"],"fact") if item["category"]=="Знания" else ""
        if subject and state=="current":
            others=db.execute("SELECT n.id,n.title FROM nodes n WHERE n.category='Знания' AND n.id<>? AND EXISTS(SELECT 1 FROM evo_versions v WHERE v.node_id=n.id) ",(node,)).fetchall()
            for other in others:
                if memory.subject(other[1],"fact")==subject and current_state(db,other[0])=="current" and memory.canonical(db,other[0])!=node:raise ValueError("Сначала отметьте прежний актуальный факт как исторический")
        if subject and item["kind"] is None:
            db.execute("INSERT OR IGNORE INTO cog_memory(node_id,kind,subject,fingerprint,source,at,confidence,priority) VALUES(?,?,?,?,?,?,?,?)",(node,"fact",subject,memory.digest(memory.norm("fact\0"+item["title"])),"manual",item["created_at"] or now(),.7,2))
        if current_state(db,node)!=state:
            db.execute("INSERT INTO evo_versions(node_id,at,state,note) VALUES(?,?,?,?)",(node,now(),state,note))
            log(db,"fact","Версия записи #%d: %s"%(node,state))
            db.execute("INSERT INTO cog_events(at,kind,detail,node_id) VALUES(?,?,?,?)",(now(),"fact","Изменён статус версии",node))
        return {"id":node,"state":state}
def review_freshness(path,data):
    node,days=data.get("id"),data.get("days")
    if type(node) is not int or type(days) is not int or not 1<=days<=3650:raise ValueError("Invalid review interval")
    with closing(connect(path)) as db,db:
        if not record(db,node):raise ValueError("Unknown record")
        db.execute("INSERT INTO evo_review VALUES(?,?,?) ON CONFLICT(node_id) DO UPDATE SET checked=excluded.checked,days=excluded.days",(node,now(),days))
        log(db,"review","Проверена актуальность записи #%d"%node)
def compress(path,data):
    ids=data.get("ids")
    if not isinstance(ids,list) or not 2<=len(ids)<=12 or any(type(i) is not int for i in ids) or len(set(ids))!=len(ids):raise ValueError("Select 2–12 distinct records")
    with closing(connect(path)) as db,db:
        rows=[record(db,i) for i in sorted(ids)]
        if any(r is None for r in rows):raise ValueError("Unknown record")
        # Extractive index, no invented facts or deletion.
        title=" · ".join(r["title"] for r in rows)
        key=json.dumps(sorted(ids))
        db.execute("INSERT OR IGNORE INTO evo_digest(at,title,source_ids) VALUES(?,?,?)",(now(),title,key))
        if db.execute("SELECT changes()").fetchone()[0]:log(db,"digest","Создана сводка из %d записей"%len(ids))
        return {"title":title,"source_ids":sorted(ids)}
def semantic_candidates(path,data):
    ident=data.get("id")
    if type(ident) is not int:raise ValueError("Record ID required")
    with closing(connect(path)) as db:
        row=record(db,ident)
        if not row:raise ValueError("Unknown record")
        if not memory.table(db,"embedding_cache"):return {"pairs":[],"status":"no_vectors"}
        v=db.execute("SELECT vector FROM embedding_cache WHERE model=? AND digest=?",(MODEL,memory.digest(row["title"]))).fetchone()
        if not v:return {"pairs":[],"status":"no_vector_for_record"}
        try:base=memory.vector(json.loads(v[0]))
        except (ValueError,TypeError):return {"pairs":[],"status":"invalid_vector"}
        # Reuse cached vector ranking rather than calling Cloud.ru. Candidate only.
        hits=memory.search(db,row["title"],MODEL,limit=32)
        pairs=[]
        for hit in hits:
            if hit["id"]==ident or hit["category"]!=row["category"]:continue
            v=db.execute("SELECT vector FROM embedding_cache WHERE model=? AND digest=?",(MODEL,memory.digest(hit["title"]))).fetchone()
            if not v:continue
            try:score=memory.cosine(base,memory.vector(json.loads(v[0])))
            except (ValueError,TypeError):continue
            if score>=.85:pairs.append({"id":hit["id"],"title":hit["title"],"similarity":round(score,3)})
        return {"pairs":pairs,"status":"candidates_only"}
def page(path,after=0,limit=200):
    if type(after) is not int or after<0 or type(limit) is not int or not 1<=limit<=500:raise ValueError("Invalid page")
    with closing(connect(path)) as db:
        rows=[dict(r) for r in db.execute("SELECT id,title,category,folder,created_at FROM nodes WHERE id>? ORDER BY id LIMIT ?",(after,limit+1))]
        more=len(rows)>limit;rows=rows[:limit]
        return {"nodes":rows,"next":rows[-1]["id"] if more else None}
def report(path):
    with closing(connect(path)) as db:
        return {"clusters":[dict(r) for r in db.execute("SELECT category,folder,COUNT(*) count FROM nodes GROUP BY category,folder ORDER BY count DESC,category,folder LIMIT 80")],
                "conflicts":conflict_rows(db),
                "versions":[dict(r) for r in db.execute("SELECT v.*,n.title FROM evo_versions v JOIN nodes n ON n.id=v.node_id ORDER BY v.id DESC LIMIT 40")],
                "due":[dict(r) for r in db.execute("SELECT r.node_id,n.title,r.checked,r.days FROM evo_review r JOIN nodes n ON n.id=r.node_id WHERE datetime(r.checked,'+'||r.days||' days')<=CURRENT_TIMESTAMP ORDER BY r.checked LIMIT 40")],
                "digests":[dict(r) for r in db.execute("SELECT * FROM evo_digest ORDER BY id DESC LIMIT 20")],
                "journal":[dict(r) for r in db.execute("SELECT * FROM evo_journal ORDER BY id DESC LIMIT 40")],
                "skills":[dict(r) for r in db.execute("SELECT * FROM cog_skills ORDER BY name")],
                "goals":[dict(r) for r in db.execute("SELECT * FROM cog_goals ORDER BY id LIMIT 20")]}

def quality(path):
    with closing(connect(path)) as db:
        bad_links=db.execute("SELECT COUNT(*) FROM edges e LEFT JOIN nodes a ON a.id=e.source LEFT JOIN nodes b ON b.id=e.target WHERE a.id IS NULL OR b.id IS NULL OR e.source>=e.target").fetchone()[0]
        bad_versions=db.execute("SELECT COUNT(*) FROM evo_versions v LEFT JOIN nodes n ON n.id=v.node_id WHERE n.id IS NULL").fetchone()[0]
        bad_digests=0
        for row in db.execute("SELECT source_ids FROM evo_digest"):
            try:
                ids=json.loads(row[0])
                if not isinstance(ids,list) or not 2<=len(ids)<=12 or any(type(i) is not int for i in ids) or len(set(ids))!=len(ids) or any(not db.execute("SELECT 1 FROM nodes WHERE id=?",(i,)).fetchone() for i in ids):bad_digests+=1
            except (ValueError,TypeError):bad_digests+=1
        foreign=sum(1 for _ in db.execute("PRAGMA foreign_key_check"))
        aliases=db.execute("SELECT COUNT(*) FROM cog_aliases a JOIN cog_aliases b ON a.canonical_id=b.alias_id").fetchone()[0]
        missing_projection=db.execute("SELECT COUNT(*) FROM cog_relations r WHERE r.state='approved' AND r.kind IN ('association','cause') AND NOT EXISTS(SELECT 1 FROM edges e WHERE e.source=MIN(r.source,r.target) AND e.target=MAX(r.source,r.target))").fetchone()[0]
        checks=[{"name":"Целостность связей","issues":bad_links},{"name":"Источники версий","issues":bad_versions},{"name":"Источники сводок","issues":bad_digests},{"name":"Внешние ключи всех таблиц","issues":foreign},{"name":"Цепочки групп дубликатов","issues":aliases},{"name":"Отсутствующие связи атласа","issues":missing_projection}]
        return {"checks":checks,"ok":not any(x["issues"] for x in checks)}

def preview(path,q):
    if not isinstance(q,str) or not 1<=len(q.strip())<=300:raise ValueError("Invalid query")
    with closing(connect(path)) as db:
        return retrieve(db,q,active_only=True)
