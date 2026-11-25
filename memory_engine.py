"""Shared, bounded-memory retrieval across the entire SQLite atlas."""
import hashlib
import heapq
import json
import math
import re
import unicodedata

STOP=set("это как что где когда или для мне меня мой моя твой тебе нужно будет надо хочу сделать про из на по в и а но не the and for you".split())
def norm(text):
    return " ".join(unicodedata.normalize("NFKC",text).casefold().split())
def terms(text):
    return {x for x in re.findall(r"\w{2,}",norm(text)) if x not in STOP}
def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()
def similarity(a,b):
    x,y=terms(a),terms(b)
    return len(x&y)/max(1,len(x|y))
def vector(value):
    if not isinstance(value,list) or not 1<=len(value)<=8192 or any(type(x) not in (int,float) or not math.isfinite(x) or abs(x)>1e6 for x in value) or not any(value):
        raise ValueError("Invalid vector")
    return value
def cosine(a,b):
    if len(a)!=len(b): return 0
    sa=max(map(abs,a),default=0);sb=max(map(abs,b),default=0)
    if not sa or not sb:return 0.0
    x=[v/sa for v in a];y=[v/sb for v in b]
    return max(-1.0,min(1.0,math.fsum(u*v for u,v in zip(x,y))/(math.hypot(*x)*math.hypot(*y))))
def table(db,name):
    return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",(name,)).fetchone() is not None
def register(db):
    db.create_function("memory_norm",1,norm,deterministic=True)
    db.create_function("memory_digest",1,digest,deterministic=True)
def existing(db,title,category,folder=None):
    register(db)
    sql="SELECT id FROM nodes WHERE category=? AND memory_norm(title)=?"
    args=[category,norm(title)]
    if folder is not None:
        sql+=" AND folder=?";args.append(folder)
    return db.execute(sql+" ORDER BY id LIMIT 1",args).fetchone()
def search(db,query,model=None,limit=8,active_only=False):
    if not isinstance(query,str) or not query.strip() or len(query)>3000: return []
    q=terms(query);register(db)
    qvec=None
    if model and table(db,"embedding_cache"):
        hit=db.execute("SELECT vector FROM embedding_cache WHERE model=? AND digest=?",(model,digest(query.strip()))).fetchone()
        if hit:
            try:qvec=vector(json.loads(hit[0]))
            except (ValueError,TypeError):pass
    has_meta=table(db,"cog_memory")
    has_alias=table(db,"cog_aliases")
    cols="n.id,n.title,n.category,n.folder,"+("m.kind,m.confidence,m.priority,m.recall_count" if has_meta else "NULL,NULL,NULL,NULL")
    join=" LEFT JOIN cog_memory m ON m.node_id=n.id" if has_meta else ""
    if qvec is not None:
        cols+=",v.vector";join+=" LEFT JOIN embedding_cache v ON v.model=? AND v.digest=memory_digest(n.title)"
    else:cols+=",NULL"
    filters=[]
    if has_alias: filters.append("NOT EXISTS(SELECT 1 FROM cog_aliases a WHERE a.alias_id=n.id)")
    if active_only and table(db,"evo_versions"): filters.append("COALESCE((SELECT state FROM evo_versions e WHERE e.node_id=n.id ORDER BY e.id DESC LIMIT 1),'unverified')<>'historical'")
    where=" WHERE "+" AND ".join(filters) if filters else ""
    args=(model,) if qvec is not None else ()
    base="nodes n"
    if qvec is None and q and table(db,"memory_postings") and table(db,"memory_indexed"):
        marks=",".join("?" for _ in q)
        base="(SELECT node_id id FROM memory_postings WHERE term IN ("+marks+") UNION SELECT id FROM nodes WHERE NOT EXISTS(SELECT 1 FROM memory_indexed i WHERE i.node_id=nodes.id)) candidates JOIN nodes n ON n.id=candidates.id"
        args=tuple(sorted(q))
    rows=db.execute("SELECT "+cols+" FROM "+base+join+where,args)
    def ranked():
        for row in rows:
            i,title,cat,folder,kind,conf,priority,recalls,raw=row
            words=terms(title+" "+cat+" "+folder)
            lexical=len(q&words)/max(1,len(q|words))
            semantic=0
            if qvec is not None and raw:
                try:semantic=max(0,cosine(qvec,vector(json.loads(raw))))
                except (ValueError,TypeError):pass
            score=lexical+semantic
            if score>0: yield (score,priority or 0,i,{"id":i,"title":title,"category":cat,"folder":folder,"kind":kind,"confidence":conf,"priority":priority,"recall_count":recalls,"score":round(score,3)})
    return [row[3] for row in heapq.nlargest(limit,ranked(),key=lambda x:x[:3])]

def subject(title,kind):
    if kind!="fact":return ""
    match=re.fullmatch(r"([^=:]{1,80})\s*[=:]\s*(\S.*)",title)
    return norm(match[1]) if match else ""
def canonical(db,node):
    seen=set()
    while node not in seen:
        seen.add(node)
        row=db.execute("SELECT canonical_id FROM cog_aliases WHERE alias_id=?",(node,)).fetchone()
        if not row:return node
        node=row[0]
    raise ValueError("Цикл группы дубликатов")
def current_state(db,node):
    if not table(db,"evo_versions"):return "unverified"
    row=db.execute("SELECT state FROM evo_versions WHERE node_id=? ORDER BY id DESC LIMIT 1",(node,)).fetchone()
    return row[0] if row else "unverified"
def active_conflict(db,subject,fp):
    if not subject:return False
    return bool(db.execute("SELECT 1 FROM cog_memory m WHERE subject=? AND fingerprint<>? AND COALESCE((SELECT state FROM evo_versions v WHERE v.node_id=m.node_id ORDER BY id DESC LIMIT 1),'unverified')<>'historical' AND NOT EXISTS(SELECT 1 FROM cog_aliases a WHERE a.alias_id=m.node_id) LIMIT 1",(subject,fp)).fetchone())

def init_index(db):
    db.execute("CREATE TABLE IF NOT EXISTS memory_indexed(node_id INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE)")
    db.execute("CREATE TABLE IF NOT EXISTS memory_postings(term TEXT NOT NULL,node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,PRIMARY KEY(term,node_id))")
    db.execute("CREATE INDEX IF NOT EXISTS memory_postings_node ON memory_postings(node_id)")
    db.execute("CREATE TRIGGER IF NOT EXISTS memory_invalidate AFTER UPDATE OF title,category,folder ON nodes BEGIN DELETE FROM memory_postings WHERE node_id=NEW.id; DELETE FROM memory_indexed WHERE node_id=NEW.id; END")
def index_batch(db,limit=200):
    rows=db.execute("SELECT id,title,category,folder FROM nodes n WHERE NOT EXISTS(SELECT 1 FROM memory_indexed i WHERE i.node_id=n.id) ORDER BY id LIMIT ?",(limit,)).fetchall()
    for ident,title,category,folder in rows:
        db.executemany("INSERT OR IGNORE INTO memory_postings VALUES(?,?)",((word,ident) for word in terms(title+" "+category+" "+folder)))
        db.execute("INSERT OR IGNORE INTO memory_indexed VALUES(?)",(ident,))
    return len(rows)
