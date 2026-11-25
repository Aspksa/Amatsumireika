"""Explicit Cloud.ru chat requests and durable, non-replayed jobs."""
import hashlib
import json
import math
import re
import sqlite3
import time
from contextlib import closing
from datetime import datetime, timezone
from threading import Lock, Thread
from urllib.request import Request, build_opener
from urllib.error import HTTPError, URLError
import cloud_api

BASE = "https://foundation-models.api.cloud.ru/v1"
ACTIVE = Lock()
TOKEN_LIMIT = 1024
# Capability labels are hints unless explicitly documented; unknown models are not assumed to support tools.
KNOWN = {
    "deepseek-ai/DeepSeek-V3.1-Terminus": ("LLM", ["tools","json","reasoning"]),
    "Qwen/Qwen3-Embedding-0.6B": ("Embedding", []),
    "openai/gpt-5.5": ("LLM", ["tools","json"]),
    "openai/gpt-5.4-nano": ("LLM", ["tools","json"]),
    "openai/gpt-oss-20b": ("LLM", ["tools","json"]),
    "qwen/qwen3-max-thinking": ("LLM", ["tools","json","reasoning"]),
}
def classify(model):
    if model in KNOWN:
        kind, caps = KNOWN[model]
        return {"id":model,"kind":kind,"capabilities":caps,"source":"documented"}
    name=model.lower()
    kind="Embedding" if "embed" in name or "bge-m3" in name else "Reranker" if "rerank" in name else "Other" if any(x in name for x in ("whisper","tts","speech","image","diffusion")) else "Unknown"
    return {"id":model,"kind":kind,"capabilities":[],"source":"name_hint"}

def now():
    return datetime.now(timezone.utc).isoformat()

def db_open(path):
    db=cloud_api.connect(path)
    db.executescript("""
    CREATE TABLE IF NOT EXISTS cloud_jobs(
      id TEXT PRIMARY KEY, model TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL,
      created TEXT NOT NULL, finished TEXT, prompt TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '', input_tokens INTEGER, output_tokens INTEGER,
      latency_ms INTEGER, tool_result TEXT NOT NULL DEFAULT '', fingerprint TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS cloud_jobs_created ON cloud_jobs(created);
    CREATE TABLE IF NOT EXISTS embedding_cache(
      model TEXT NOT NULL, digest TEXT NOT NULL, vector TEXT NOT NULL, PRIMARY KEY(model,digest));
    """)
    return db

def recover(path):
    with closing(db_open(path)) as db, db:
        db.execute("UPDATE cloud_jobs SET status='interrupted',error='Server stopped; no automatic retry',finished=? WHERE status IN ('queued','running')",(now(),))

def status(path, ident):
    with closing(db_open(path)) as db:
        row=db.execute("SELECT id,model,mode,status,created,finished,answer,error,input_tokens,output_tokens,latency_ms,tool_result FROM cloud_jobs WHERE id=?",(ident,)).fetchone()
        if not row: raise ValueError("Request not found")
        return dict(row)

def history(path):
    with closing(db_open(path)) as db:
        rows=db.execute("SELECT id,model,mode,status,created,finished,error,input_tokens,output_tokens,latency_ms FROM cloud_jobs ORDER BY created DESC LIMIT 100").fetchall()
        groups=db.execute("SELECT model,COUNT(*) requests,SUM(status='done') successes,SUM(COALESCE(input_tokens,0)) input_tokens,SUM(COALESCE(output_tokens,0)) output_tokens,SUM(input_tokens IS NULL OR output_tokens IS NULL) unknown_usage,CAST(AVG(latency_ms) AS INTEGER) latency_ms FROM cloud_jobs GROUP BY model ORDER BY model").fetchall()
        return {"jobs":[dict(r) for r in rows],"models":[dict(r) for r in groups]}

def words(text):
    return set(re.findall(r"\w{2,}",text.casefold()))

def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()

def vector(value):
    if not isinstance(value,list) or not 1<=len(value)<=8192 or any(type(x) not in (int,float) or not math.isfinite(x) or abs(x)>1e6 for x in value):
        raise ValueError("Invalid vector")
    if not any(value): raise ValueError("Zero vector")
    return value

def cache_vector(db,model,text,value):
    db.execute("INSERT OR REPLACE INTO embedding_cache VALUES(?,?,?)",(model,digest(text),json.dumps(vector(value))))

def cosine(a,b):
    if len(a)!=len(b): return 0
    return sum(x*y for x,y in zip(a,b))/(math.sqrt(sum(x*x for x in a))*math.sqrt(sum(y*y for y in b)))

def search(path,query,model=None):
    """Text search always works offline; vector score only with matching cached vectors."""
    with closing(db_open(path)) as db:
        q=words(query)
        qrow=db.execute("SELECT vector FROM embedding_cache WHERE model=? AND digest=?",(model,digest(query))).fetchone() if model else None
        qvec=vector(json.loads(qrow[0])) if qrow else None
        rows=db.execute("SELECT id,title,category,folder FROM nodes ORDER BY id DESC LIMIT 20000").fetchall()
        scored=[]
        for row in rows:
            text=row["title"]
            terms=words(text+" "+row["category"]+" "+row["folder"])
            lexical=len(q&terms)/max(1,len(q))
            semantic=0
            if qvec:
                hit=db.execute("SELECT vector FROM embedding_cache WHERE model=? AND digest=?",(model,digest(text))).fetchone()
                if hit: semantic=max(0,cosine(qvec,vector(json.loads(hit[0]))))
            score=lexical+semantic
            if score>0: scored.append((score,dict(row)))
        scored.sort(key=lambda x:-x[0])
        return [r for _,r in scored[:8]]

def submit(path,data):
    if data.get("confirm") is not True:
        raise ValueError("Explicit paid request consent required")
    ident, prompt, mode=data.get("id"),data.get("content"),data.get("mode","chat")
    if not isinstance(ident,str) or not re.fullmatch(r"[a-f0-9-]{32,36}",ident):
        raise ValueError("Invalid request ID")
    if not isinstance(prompt,str) or not 1<=len(prompt.strip())<=3000 or mode not in ("chat","json","tools"):
        raise ValueError("Invalid request")
    prompt=prompt.strip()
    fingerprint=digest(mode+"\0"+prompt)
    with closing(db_open(path)) as db:
        old=db.execute("SELECT fingerprint FROM cloud_jobs WHERE id=?",(ident,)).fetchone()
        if old:
            if old[0]!=fingerprint: raise ValueError("Request ID already used")
            return status(path,ident)
    if not ACTIVE.acquire(False):
        raise ValueError("Another cloud request is running")
    try:
        with cloud_api.LOCK, closing(db_open(path)) as db:
            key,_=cloud_api.read_key(db,path)
            model=db.execute("SELECT model FROM cloud_config WHERE id=1").fetchone()[0]
            if not key or not model:
                raise ValueError("Configure API key and model first")
            caps=classify(model)
            if caps["kind"] in ("Embedding","Reranker","Other"):
                raise ValueError("Select a chat model")
            if mode!="chat" and mode not in caps["capabilities"]:
                raise ValueError("Model capability is not confirmed")
            if key in prompt:
                raise ValueError("Do not send API keys in chat")
            # Same text within 60 seconds is not billed twice, even with a new ID.
            recent=db.execute("SELECT id FROM cloud_jobs WHERE fingerprint=? AND model=? AND created>=? ORDER BY created DESC LIMIT 1",(fingerprint,model,datetime.fromtimestamp(time.time()-60,timezone.utc).isoformat())).fetchone()
            if recent: 
                ACTIVE.release()
                return status(path,recent[0])
            with db:
                db.execute("INSERT INTO cloud_jobs(id,model,mode,status,created,prompt,fingerprint) VALUES(?,?,?,?,?,?,?)",(ident,model,mode,"queued",now(),prompt,fingerprint))
        Thread(target=run_job,args=(path,ident,key,model,prompt,mode),daemon=True).start()
        return status(path,ident)
    except Exception:
        ACTIVE.release()
        raise

def stream_response(key, payload):
    req=Request(BASE+"/chat/completions",data=json.dumps(payload).encode(),headers={"Authorization":"Bearer "+key,"Content-Type":"application/json","Accept":"text/event-stream"},method="POST")
    with build_opener(cloud_api.NoRedirect()).open(req,timeout=45) as response:
        if "text/event-stream" not in response.headers.get("Content-Type",""):
            raise ValueError("Expected SSE stream")
        parts=[]
        while True:
            raw=response.readline(1_000_001)
            if not raw: break
            if len(raw)>1_000_000: raise ValueError("SSE line too large")
            line=raw.decode("utf-8").rstrip("\r\n")
            if not line:
                if parts:
                    data="\n".join(parts);parts=[]
                    if data=="[DONE]":
                        yield None
                        return
                    yield json.loads(data)
            elif line.startswith("data:"):
                parts.append(line[5:].lstrip(" "))
                if sum(map(len,parts))>1_000_000: raise ValueError("SSE event too large")
        raise ValueError("Incomplete stream")

def run_job(path,ident,key,model,prompt,mode):
    answer="";error="";tool_result="";usage=(None,None);start=time.monotonic();outcome="failed"
    try:
        with closing(db_open(path)) as db, db:
            db.execute("UPDATE cloud_jobs SET status='running' WHERE id=?",(ident,))
            db.execute("UPDATE cloud_config SET requests=requests+1,generation_requests=generation_requests+1 WHERE id=1")
        payload={"model":model,"messages":[{"role":"system","content":"You are Amatsumireika, a helpful assistant. Answer the user's request. Never claim access to local data unless provided."},{"role":"user","content":prompt}],"max_completion_tokens":TOKEN_LIMIT,"stream":True,"stream_options":{"include_usage":True}}
        if mode=="json": payload["response_format"]={"type":"json_object"}
        if mode=="tools": payload["tools"]=[{"type":"function","function":{"name":"local_counts","description":"Read number of local memory records and links","parameters":{"type":"object","properties":{},"additionalProperties":False}}}];payload["tool_choice"]="auto";payload["parallel_tool_calls"]=False
        names={};args={};done=False;last_write=0
        for chunk in stream_response(key,payload):
            if chunk is None: done=True;break
            if time.monotonic()-start>180: raise TimeoutError()
            if not isinstance(chunk,dict) or "error" in chunk: raise ValueError("Provider stream error")
            u=chunk.get("usage")
            if isinstance(u,dict):
                usage=tuple(u.get(k) if type(u.get(k)) is int and 0<=u[k]<=100_000_000 else None for k in ("prompt_tokens","completion_tokens"))
            for choice in chunk.get("choices") or []:
                if choice.get("index",0)!=0: continue
                delta=choice.get("delta") or {}
                content=delta.get("content")
                if isinstance(content,str): answer+=content
                for call in delta.get("tool_calls") or []:
                    idx=call.get("index",0)
                    if type(idx) is not int or not 0<=idx<4: raise ValueError("Invalid tool index")
                    fn=call.get("function") or {}
                    names[idx]=names.get(idx,"")+fn.get("name","")
                    args[idx]=args.get(idx,"")+fn.get("arguments","")
            if len(answer)>100_000 or sum(map(len,args.values()))>4096: raise ValueError("Output too large")
            if time.monotonic()-last_write>.15:
                with closing(db_open(path)) as db, db: db.execute("UPDATE cloud_jobs SET answer=? WHERE id=?",(answer,ident))
                last_write=time.monotonic()
        if not done: raise ValueError("Incomplete stream")
        if names:
            if mode!="tools" or names!={0:"local_counts"} or json.loads(args.get(0,"{}"))!={}: raise ValueError("Tool not permitted")
            with closing(db_open(path)) as db:
                tool_result=json.dumps({"nodes":db.execute("SELECT COUNT(*) FROM nodes").fetchone()[0],"edges":db.execute("SELECT COUNT(*) FROM edges").fetchone()[0]})
            # Do not automatically send local data back to the provider or charge a second request.
        elif mode=="json":
            if not isinstance(json.loads(answer),dict): raise ValueError("Expected JSON object")
        if not answer and not tool_result: raise ValueError("No answer text")
        outcome="done"
    except HTTPError as exc:
        error="rate_limited" if exc.code==429 else "unauthorized" if exc.code in (401,403) else "provider_http_"+str(exc.code)
    except (URLError,OSError,TimeoutError):
        error="network_error"
    except Exception:
        error="invalid_or_incomplete_response"
    finally:
        try:
            with closing(db_open(path)) as db, db:
                db.execute("UPDATE cloud_jobs SET status=?,finished=?,answer=?,error=?,input_tokens=?,output_tokens=?,latency_ms=?,tool_result=? WHERE id=?",(outcome,now(),answer,error,*usage,round((time.monotonic()-start)*1000),tool_result,ident))
                db.execute("UPDATE cloud_config SET successes=successes+?,failures=failures+?,input_tokens=input_tokens+?,output_tokens=output_tokens+? WHERE id=1",(int(outcome=="done"),int(outcome!="done"),usage[0] or 0,usage[1] or 0))
        finally:
            ACTIVE.release()
