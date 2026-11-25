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
    return sum(x*y for x,y in zip(a,b))/(math.sqrt(sum(x*x for x in a))*math.sqrt(sum(y*y for y in b)))
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
def search(db,query,model=None,limit=8):
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
    where=" WHERE NOT EXISTS(SELECT 1 FROM cog_aliases a WHERE a.alias_id=n.id)" if has_alias else ""
    rows=db.execute("SELECT "+cols+" FROM nodes n"+join+where,(model,) if qvec is not None else ())
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
