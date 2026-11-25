"""Local, bounded cognitive rules. No network, model calls or self-modifying code."""
import hashlib
import json
import logging
import re
import sqlite3
import time
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from threading import Event, Lock, Thread

LOCK=Lock()
BATCH=20
PERSONA={"name":"Amatsumireika","identity":"Вымышленный образ небесной императрицы кицунэ","character":"Сдержанная, внимательная, решительная","values":["Точность","Уважение","Безопасность","Согласие пользователя"],"limitations":"Программная модель личности; не сознание, не реальные эмоции","version":1}
TYPES={"fact":"Знания","episode":"Воспоминания","procedure":"Навыки","preference":"Личность","habit":"Опыт","cause":"Логика","goal":"Цели"}
LABELS={"факт":"fact","событие":"episode","навык":"procedure","привычка":"habit","предпочтение":"preference","причина":"cause","цель":"goal","запомни":"fact"}
SECRET=re.compile(r"(?i)(api[_ -]?key|password|парол|секретн.{0,8}ключ|bearer\s|sk-[\w-]+|токен\s*[:=]|-----BEGIN|[\w.+-]+@[\w.-]+\.\w+|\d{12,})")
STOP=set("это как что где когда или для мне меня мой моя твой тебе нужно будет надо хочу сделать про из на по в и а но не the and for you".split())
def now(): return datetime.now(timezone.utc).isoformat()
def norm(s): return " ".join(s.casefold().split())
def digest(s): return hashlib.sha256(norm(s).encode()).hexdigest()
def terms(s): return {x for x in re.findall(r"\w{3,}",norm(s)) if x not in STOP}
def safe(s): return isinstance(s,str) and 3<=len(s)<=160 and not SECRET.search(s) and not any(ord(c)<32 for c in s)
def similarity(a,b): 
    x,y=terms(a),terms(b)
    return len(x&y)/max(1,len(x|y))
def intent(text):
    t=norm(text)
    for kind,pattern in (("memory",r"^(запомни|вспомни|найди в памяти|факт:)"),("plan",r"^(план|составь план|как сделать|как реализовать)"),("repair",r"(ошибк|баг|не работает|исправ)"),("learn",r"(объясни|научи|изучи|как устроен)"),("search",r"(найди|поищи|где)"),("calculate",r"(рассчитай|посчитай|сколько)")):
        if re.search(pattern,t): return kind
    return "question" if "?" in text else "dialogue"
def plan(text):
    kind=intent(text)
    steps={"repair":["Воспроизвести проблему","Проверить журнал и условия","Проверить исправление"],"search":["Уточнить запрос","Найти локальные совпадения","Проверить источники"],"learn":["Определить тему","Разобрать примеры","Проверить понимание"],"calculate":["Уточнить единицы и входные данные","Рассчитать","Проверить результат"]}.get(kind,["Определить цель","Разделить задачу на проверяемые шаги","Проверить результат"])
    return {"intent":kind,"steps":steps,"executed":False}
def init(db):
    db.executescript("""
    CREATE TABLE IF NOT EXISTS cog_state(id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 1, last_cycle TEXT, cycles INTEGER NOT NULL DEFAULT 0, last_intent TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '', style TEXT NOT NULL DEFAULT 'Сдержанный');
    INSERT OR IGNORE INTO cog_state(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS cog_seen(source TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS cog_candidates(id INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, title TEXT NOT NULL, source TEXT NOT NULL, at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', subject TEXT NOT NULL DEFAULT '', confidence REAL NOT NULL, priority INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS cog_memory(node_id INTEGER PRIMARY KEY REFERENCES nodes(id), kind TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '', fingerprint TEXT NOT NULL, source TEXT NOT NULL, at TEXT NOT NULL, confidence REAL NOT NULL, priority INTEGER NOT NULL, recall_count INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS cog_memory_fp ON cog_memory(fingerprint);
    CREATE INDEX IF NOT EXISTS cog_memory_subject ON cog_memory(subject);
    CREATE TABLE IF NOT EXISTS cog_relations(source INTEGER NOT NULL REFERENCES nodes(id),target INTEGER NOT NULL REFERENCES nodes(id),kind TEXT NOT NULL, evidence TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'suggested', PRIMARY KEY(source,target,kind));
    CREATE TABLE IF NOT EXISTS cog_events(id INTEGER PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, node_id INTEGER);
    CREATE TABLE IF NOT EXISTS cog_skills(name TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, successes INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS cog_feedback(id INTEGER PRIMARY KEY, at TEXT NOT NULL, job TEXT NOT NULL UNIQUE, helpful INTEGER NOT NULL, note TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cog_goals(id INTEGER PRIMARY KEY, code TEXT UNIQUE, title TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'suggested');
    """)
def connect(path):
    db=sqlite3.connect(path,timeout=5)
    db.row_factory=sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    return db
def emit(db,kind,detail,node=None):
    db.execute("INSERT INTO cog_events(at,kind,detail,node_id) VALUES(?,?,?,?)",(now(),kind,detail,node))
def proposal(db,kind,title,source,subject="",confidence=.7,priority=1):
    title=title.strip()
    if kind not in TYPES or not safe(title): return
    fp=digest(kind+"\0"+title)
    if db.execute("SELECT 1 FROM cog_memory WHERE fingerprint=?",(fp,)).fetchone(): return
    changed=db.execute("INSERT OR IGNORE INTO cog_candidates(fingerprint,kind,title,source,at,subject,confidence,priority) VALUES(?,?,?,?,?,?,?,?)",(fp,kind,title,source,now(),subject,confidence,priority)).rowcount
    if changed: emit(db,"proposal","Найден кандидат памяти: "+kind)
def inspect_message(db,source,text):
    if db.execute("INSERT OR IGNORE INTO cog_seen VALUES(?)",(source,)).rowcount==0:return
    kind=intent(text)
    db.execute("UPDATE cog_state SET last_intent=? WHERE id=1",(kind,))
    # Conservative local extraction: explicit labels and short first-person preferences.
    if SECRET.search(text): return
    m=re.fullmatch(r"\s*(факт|событие|навык|привычка|предпочтение|причина|цель|запомни)\s*[:：]\s*(.+)",text,re.I)
    if m:
        k=LABELS[m[1].casefold()];title=m[2].strip()
        subject=norm(title.split("=",1)[0]) if "=" in title and k=="fact" else ""
        proposal(db,k,title,source,subject,.85,2)
    elif re.fullmatch(r"(?i)я предпочитаю [^?!\n]{3,120}[.]?",text):
        proposal(db,"preference",text.strip(),source,confidence=.55)
def skill(db,name,success):
    db.execute("INSERT INTO cog_skills VALUES(?,1,?,?) ON CONFLICT(name) DO UPDATE SET attempts=attempts+1,successes=successes+excluded.successes,failures=failures+excluded.failures",(name,int(success),int(not success)))
def cycle(path,force=False):
    if not LOCK.acquire(False): return {"busy":True}
    started=time.monotonic()
    try:
        with closing(connect(path)) as db:
            init(db)
            with db:
                if not force and not db.execute("SELECT enabled FROM cog_state WHERE id=1").fetchone()[0]: return {"paused":True}
                db.execute("BEGIN IMMEDIATE")
                rows=db.execute("SELECT id,content FROM chat_messages m WHERE role='user' AND NOT EXISTS(SELECT 1 FROM cog_seen s WHERE s.source='local:'||m.id) ORDER BY id LIMIT ?",(BATCH,)).fetchall()
                for row in rows: inspect_message(db,"local:"+str(row["id"]),row["content"])
                processed=len(rows)
                if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cloud_jobs'").fetchone():
                    jobs=db.execute("SELECT id,prompt,mode,status,error FROM cloud_jobs j WHERE status NOT IN ('queued','running') AND NOT EXISTS(SELECT 1 FROM cog_seen s WHERE s.source='cloud:'||j.id) ORDER BY created LIMIT ?",(BATCH,)).fetchall()
                    for job in jobs:
                        inspect_message(db,"cloud:"+job["id"],job["prompt"])
                        skill(db,"Cloud.ru / "+job["mode"],job["status"]=="done")
                        if job["status"]!="done": emit(db,"failure","Облачный запрос не завершён; автоматического повтора нет")
                    processed+=len(jobs)
                # Existing manual nodes remain canonical; attach metadata incrementally, never duplicate or delete.
                records=db.execute("SELECT id,title,category,created_at FROM nodes n WHERE NOT EXISTS(SELECT 1 FROM cog_memory m WHERE m.node_id=n.id) ORDER BY id LIMIT ?",(BATCH,)).fetchall()
                for row in records:
                    k=next((k for k,v in TYPES.items() if v==row["category"]),"fact")
                    db.execute("INSERT OR IGNORE INTO cog_memory(node_id,kind,fingerprint,source,at,confidence,priority) VALUES(?,?,?,?,?,?,?)",(row["id"],k,digest(k+"\0"+row["title"]),"manual",row["created_at"] or now(),1,2))
                processed+=len(records)
                # Suggestions, not destructive consolidation. Limit comparisons to recent approved records.
                for row in records:
                    others=db.execute("SELECT id,title FROM nodes WHERE id<>? ORDER BY id DESC LIMIT 100",(row["id"],)).fetchall()
                    for other in others:
                        if not safe(row["title"]) or not safe(other["title"]): continue
                        sim=similarity(row["title"],other["title"])
                        if sim>=.6:
                            a,b=sorted((row["id"],other["id"]))
                            kind="duplicate" if norm(row["title"])==norm(other["title"]) else "association"
                            if db.execute("INSERT OR IGNORE INTO cog_relations(source,target,kind,evidence) VALUES(?,?,?,?)",(a,b,kind,"Совпадение слов: %.2f"%sim)).rowcount: emit(db,"relation","Предложена "+kind,a)
                pending=db.execute("SELECT COUNT(*) FROM cog_candidates WHERE state='pending'").fetchone()[0]
                if pending: db.execute("INSERT OR IGNORE INTO cog_goals(code,title) VALUES('review','Проверить кандидатов памяти')")
                if db.execute("SELECT 1 FROM cog_skills WHERE failures>0").fetchone(): db.execute("INSERT OR IGNORE INTO cog_goals(code,title) VALUES('errors','Разобрать неудачные операции и журнал')")
                db.execute("UPDATE cog_state SET last_cycle=?,cycles=cycles+1,last_error='' WHERE id=1",(now(),))
                emit(db,"cycle","Локальный цикл: %d объектов, %d мс"%(processed,round((time.monotonic()-started)*1000)))
                # Bound activity log only; never delete knowledge, feedback or source records.
                db.execute("DELETE FROM cog_events WHERE id < (SELECT COALESCE(MAX(id),0)-500 FROM cog_events)")
                return {"processed":processed}
    except Exception:
        logging.exception("Cognitive cycle failed")
        try:
            with closing(connect(path)) as db, db: db.execute("UPDATE cog_state SET last_error='Ошибка локального цикла' WHERE id=1")
        except sqlite3.Error: pass
        raise
    finally: LOCK.release()
@contextmanager
def worker(path):
    stop=Event()
    def loop():
        if stop.wait(2): return
        while not stop.is_set():
            try: cycle(path)
            except Exception: pass
            if stop.wait(30): break
    thread=Thread(target=loop,daemon=True,name="cognitive-local")
    thread.start()
    try: yield
    finally: stop.set();thread.join(timeout=6)
def review(path,data):
    ident,action=data.get("id"),data.get("action")
    if type(ident) is not int or action not in ("approve","reject"): raise ValueError("Invalid review")
    with closing(connect(path)) as db:
        init(db)
        with db:
            db.execute("BEGIN IMMEDIATE")
            c=db.execute("SELECT * FROM cog_candidates WHERE id=?",(ident,)).fetchone()
            if not c or c["state"]!="pending": raise ValueError("Candidate not pending")
            if action=="reject":
                db.execute("UPDATE cog_candidates SET state='rejected' WHERE id=?",(ident,));emit(db,"review","Кандидат отклонён");return
            if c["subject"] and db.execute("SELECT 1 FROM cog_memory WHERE subject=? AND fingerprint<>?",(c["subject"],c["fingerprint"])).fetchone():
                if data.get("confirm_conflict") is not True: raise ValueError("Есть другое утверждение о том же предмете. Подтвердите сохранение обоих.")
            existing=db.execute("SELECT id FROM nodes WHERE title=? AND category=? ORDER BY id LIMIT 1",(c["title"],TYPES[c["kind"]])).fetchone()
            node=existing[0] if existing else db.execute("INSERT INTO nodes(title,category,folder,created_at) VALUES(?,?,?,?)",(c["title"],TYPES[c["kind"]],"Память",now())).lastrowid
            db.execute("INSERT OR REPLACE INTO cog_memory(node_id,kind,subject,fingerprint,source,at,confidence,priority) VALUES(?,?,?,?,?,?,?,?)",(node,c["kind"],c["subject"],c["fingerprint"],c["source"],c["at"],c["confidence"],c["priority"]))
            db.execute("UPDATE cog_candidates SET state='approved' WHERE id=?",(ident,))
            if not existing: db.execute("INSERT INTO atlas_events(at,kind,detail) VALUES(?,?,?)",(now(),"node",c["title"]))
            emit(db,"memory","Кандидат принят пользователем",node)
def relation(path,data):
    a,b,kind,action=data.get("source"),data.get("target"),data.get("kind"),data.get("action")
    if type(a) is not int or type(b) is not int or a==b or kind not in ("association","duplicate","cause") or action not in ("approve","reject"): raise ValueError("Invalid relation")
    if kind!="cause": a,b=sorted((a,b))
    with closing(connect(path)) as db:
        init(db)
        with db:
            if db.execute("SELECT COUNT(*) FROM nodes WHERE id IN (?,?)",(a,b)).fetchone()[0]!=2: raise ValueError("Unknown records")
            if kind=="cause" and action=="approve":
                db.execute("INSERT OR IGNORE INTO cog_relations(source,target,kind,evidence) VALUES(?,?,?,?)",(a,b,kind,"Причина указана пользователем"))
            if not db.execute("UPDATE cog_relations SET state=? WHERE source=? AND target=? AND kind=?",("approved" if action=="approve" else "rejected",a,b,kind)).rowcount: raise ValueError("Unknown relation")
            if action=="approve" and kind!="duplicate":
                db.execute("INSERT OR IGNORE INTO edges VALUES(?,?)",tuple(sorted((a,b))))
                emit(db,"relation","Подтверждена связь: "+kind,a)
            elif kind=="duplicate": emit(db,"review","Дубликат отмечен; исходные записи сохранены",a)
def configure(path,data):
    if set(data)-{"enabled","style"}: raise ValueError("Unknown option")
    with closing(connect(path)) as db:
        init(db)
        with db:
            if "enabled" in data:
                if type(data["enabled"]) is not bool: raise ValueError("Invalid flag")
                db.execute("UPDATE cog_state SET enabled=? WHERE id=1",(int(data["enabled"]),))
            if "style" in data:
                if data["style"] not in ("Сдержанный","Дружелюбный","Деловой"): raise ValueError("Invalid style")
                db.execute("UPDATE cog_state SET style=? WHERE id=1",(data["style"],));emit(db,"persona","Пользователь изменил стиль речи")
def feedback(path,data):
    job,helpful,note=data.get("job"),data.get("helpful"),data.get("note","")
    if not isinstance(job,str) or type(helpful) is not bool or not isinstance(note,str) or len(note)>160 or (note and SECRET.search(note)): raise ValueError("Invalid feedback")
    with closing(connect(path)) as db:
        init(db)
        with db:
            if not db.execute("SELECT 1 FROM sqlite_master WHERE name='cloud_jobs'").fetchone() or not db.execute("SELECT 1 FROM cloud_jobs WHERE id=? AND status='done'",(job,)).fetchone(): raise ValueError("Unknown completed job")
            if db.execute("INSERT OR IGNORE INTO cog_feedback(at,job,helpful,note) VALUES(?,?,?,?)",(now(),job,int(helpful),note)).rowcount:
                skill(db,"Оценка ответов",helpful);emit(db,"feedback","Пользователь оценил ответ")
def lookup(path,q,record=False):
    if not isinstance(q,str) or not q.strip() or len(q)>300: raise ValueError("Invalid query")
    with closing(connect(path)) as db:
        init(db)
        rows=db.execute("SELECT n.id,n.title,n.category,m.kind,m.confidence,m.priority,m.recall_count FROM nodes n LEFT JOIN cog_memory m ON m.node_id=n.id ORDER BY n.id DESC LIMIT 20000").fetchall()
        matches=[(similarity(q,r["title"]+" "+r["category"]),dict(r)) for r in rows]
        matches=sorted((x for x in matches if x[0]>0),key=lambda x:(-x[0],-(x[1]["priority"] or 0)))[:8]
        results=[{**r,"score":round(score,3)} for score,r in matches]
        if record:
            with db:
                for r in results: db.execute("UPDATE cog_memory SET recall_count=recall_count+1 WHERE node_id=?",(r["id"],));emit(db,"recall","Извлечена локальная запись",r["id"])
        return {"results":results,"coverage":"Последние 20000 записей; поиск по словам","missing":not bool(results),"intent":intent(q)}
def dashboard(path):
    with closing(connect(path)) as db:
        init(db)
        st=dict(db.execute("SELECT * FROM cog_state WHERE id=1").fetchone())
        candidates=[dict(r) for r in db.execute("SELECT c.*,EXISTS(SELECT 1 FROM cog_memory m WHERE c.subject<>'' AND m.subject=c.subject AND m.fingerprint<>c.fingerprint) conflict FROM cog_candidates c WHERE state='pending' ORDER BY id DESC LIMIT 50")]
        relations=[dict(r) for r in db.execute("SELECT r.*,a.title source_title,b.title target_title FROM cog_relations r JOIN nodes a ON a.id=r.source JOIN nodes b ON b.id=r.target WHERE r.state='suggested' ORDER BY r.source DESC LIMIT 30")]
        counts={r[0]:r[1] for r in db.execute("SELECT kind,COUNT(*) FROM cog_memory GROUP BY kind")}
        health={"foreign_key_issues":len(db.execute("PRAGMA foreign_key_check").fetchmany(10)),"pending":db.execute("SELECT COUNT(*) FROM cog_candidates WHERE state='pending'").fetchone()[0],"nodes":db.execute("SELECT COUNT(*) FROM nodes").fetchone()[0],"edges":db.execute("SELECT COUNT(*) FROM edges").fetchone()[0]}
        return {"state":st,"persona":PERSONA,"counts":counts,"health":health,"candidates":candidates,"relations":relations,"skills":[dict(r) for r in db.execute("SELECT * FROM cog_skills ORDER BY name")],"goals":[dict(r) for r in db.execute("SELECT * FROM cog_goals ORDER BY id LIMIT 20")],"events":[dict(r) for r in db.execute("SELECT * FROM cog_events ORDER BY id DESC LIMIT 30")]}
def system_profile(path,prompt):
    # Only fixed persona and approved style, never local memories or user preferences.
    with closing(connect(path)) as db:
        init(db);style=db.execute("SELECT style FROM cog_state WHERE id=1").fetchone()[0]
    return " You portray Amatsumireika, a fictional celestial kitsune empress. Be accurate, respectful, and clear about limitations. Do not claim consciousness. Speech style: "+style+". User request category: "+intent(prompt)+"."
