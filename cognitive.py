"""Local, bounded cognitive rules. No network, model calls or self-modifying code."""
import hashlib
import memory_engine as memory
import evolution
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
TYPES={"fact":"Знания","episode":"Воспоминания","procedure":"Навыки","preference":"Личность","habit":"Опыт","cause":"Логика","goal":"Цели","document":"Документы","emotion":"Эмоции"}
LABELS={"факт":"fact","событие":"episode","навык":"procedure","привычка":"habit","предпочтение":"preference","причина":"cause","цель":"goal","запомни":"fact"}
SECRET=re.compile(r"(?i)(api[_ -]?key|password|парол|секретн.{0,8}ключ|bearer\s|sk-[\w-]+|токен\s*[:=]|-----BEGIN|[\w.+-]+@[\w.-]+\.\w+|\d{12,})")
STOP=set("это как что где когда или для мне меня мой моя твой тебе нужно будет надо хочу сделать про из на по в и а но не the and for you".split())
def now(): return datetime.now(timezone.utc).isoformat()
norm=memory.norm
def digest(s): return hashlib.sha256(norm(s).encode()).hexdigest()
terms=memory.terms
def safe(s): return isinstance(s,str) and 3<=len(s)<=160 and not SECRET.search(s) and not any(ord(c)<32 for c in s)
similarity=memory.similarity
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
    if memory.table(db,"cog_aliases") and memory.table(db,"cog_indexed"): return
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
    CREATE TABLE IF NOT EXISTS cog_aliases(alias_id INTEGER PRIMARY KEY REFERENCES nodes(id), canonical_id INTEGER NOT NULL REFERENCES nodes(id), CHECK(alias_id<>canonical_id));
    CREATE INDEX IF NOT EXISTS cog_relations_kind ON cog_relations(kind,state,source,target);
    CREATE TABLE IF NOT EXISTS cog_indexed(node_id INTEGER PRIMARY KEY REFERENCES nodes(id));
    CREATE TABLE IF NOT EXISTS cog_terms(term TEXT NOT NULL,node_id INTEGER NOT NULL REFERENCES nodes(id),PRIMARY KEY(term,node_id));
    CREATE INDEX IF NOT EXISTS cog_terms_node ON cog_terms(node_id);
    """)
def connect(path):
    db=sqlite3.connect(path,timeout=5)
    db.row_factory=sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    memory.register(db)
    return db
def emit(db,kind,detail,node=None):
    db.execute("INSERT INTO cog_events(at,kind,detail,node_id) VALUES(?,?,?,?)",(now(),kind,detail,node))
def proposal(db,kind,title,source,subject="",confidence=.7,priority=1):
    title=title.strip()
    if kind not in TYPES or not safe(title): return
    fp=digest(kind+"\0"+title)
    if db.execute("SELECT 1 FROM cog_memory WHERE fingerprint=?",(fp,)).fetchone() or memory.existing(db,title,TYPES[kind]): return
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
        subject=subject_of(title,k)
        proposal(db,k,title,source,subject,.85,2)
    elif re.fullmatch(r"(?i)я предпочитаю [^?!\n]{3,120}[.]?",text):
        proposal(db,"preference",text.strip(),source,confidence=.55)
subject_of=memory.subject
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
                if memory.table(db,"memory_indexed"): memory.index_batch(db)
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
                    db.execute("INSERT OR IGNORE INTO cog_memory(node_id,kind,subject,fingerprint,source,at,confidence,priority) VALUES(?,?,?,?,?,?,?,?)",(row["id"],k,subject_of(row["title"],k),digest(k+"\0"+row["title"]),"manual",row["created_at"] or now(),.7,2))
                processed+=len(records)
                # Indexed candidates across all previously processed nodes; bounded by overlap.
                to_index=db.execute("SELECT id,title,category FROM nodes n WHERE EXISTS(SELECT 1 FROM cog_memory m WHERE m.node_id=n.id) AND NOT EXISTS(SELECT 1 FROM cog_indexed i WHERE i.node_id=n.id) ORDER BY id LIMIT ?",(BATCH,)).fetchall()
                for row in to_index:
                    db.execute("INSERT OR IGNORE INTO cog_indexed VALUES(?)",(row["id"],))
                    if safe(row["title"]):
                        db.executemany("INSERT OR IGNORE INTO cog_terms VALUES(?,?)",((w,row["id"]) for w in sorted(terms(row["title"]))))
                for row in to_index:
                    if not safe(row["title"]): continue
                    others=db.execute("SELECT n.id,n.title,n.category FROM nodes n JOIN cog_memory m ON m.node_id=n.id WHERE m.fingerprint=(SELECT fingerprint FROM cog_memory WHERE node_id=?) AND n.id<>? ORDER BY n.id LIMIT 100",(row["id"],row["id"])).fetchall()
                    others+=db.execute("SELECT n.id,n.title,n.category FROM cog_terms t JOIN cog_terms u ON u.term=t.term JOIN nodes n ON n.id=u.node_id WHERE t.node_id=? AND u.node_id<>? GROUP BY n.id ORDER BY COUNT(*) DESC,n.id LIMIT 100",(row["id"],row["id"])).fetchall()
                    for other in others:
                        if not safe(other["title"]): continue
                        sim=similarity(row["title"],other["title"])
                        exact=row["category"]==other["category"] and norm(row["title"])==norm(other["title"]) and row["category"]!="Документы"
                        if sim>=.6 or exact:
                            a,b=sorted((row["id"],other["id"]))
                            kind="duplicate" if exact else "association"
                            if db.execute("INSERT OR IGNORE INTO cog_relations(source,target,kind,evidence) VALUES(?,?,?,?)",(a,b,kind,"Совпадение слов: %.2f"%sim)).rowcount: emit(db,"relation","Предложена "+kind,a)
                pending=db.execute("SELECT COUNT(*) FROM cog_candidates WHERE state='pending'").fetchone()[0]
                if pending: db.execute("INSERT INTO cog_goals(code,title) VALUES('review','Проверить кандидатов памяти') ON CONFLICT(code) DO UPDATE SET state='suggested'")
                else: db.execute("UPDATE cog_goals SET state='done' WHERE code='review'")
                if db.execute("SELECT 1 FROM cog_skills WHERE failures>0").fetchone(): db.execute("INSERT OR IGNORE INTO cog_goals(code,title) VALUES('errors','Разобрать неудачные операции и журнал')")
                db.execute("UPDATE cog_state SET last_cycle=?,cycles=cycles+1,last_error='' WHERE id=1",(now(),))
                if processed or to_index:
                    emit(db,"cycle","Локальный цикл: %d объектов, %d мс"%(processed,round((time.monotonic()-started)*1000)))
                    if memory.table(db,"evo_journal"): evolution.log(db,"cycle","Обработано %d объектов; индексировано %d"%(processed,len(to_index)))
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
    if type(ident) is not int or action not in ("approve","reject","reopen"): raise ValueError("Invalid review")
    with closing(connect(path)) as db:
        init(db)
        with db:
            db.execute("BEGIN IMMEDIATE")
            c=db.execute("SELECT * FROM cog_candidates WHERE id=?",(ident,)).fetchone()
            if action=="reopen":
                if not c or c["state"]!="rejected": raise ValueError("Candidate not rejected")
                db.execute("UPDATE cog_candidates SET state='pending' WHERE id=?",(ident,));emit(db,"review","Кандидат возвращён на проверку");return
            if not c or c["state"]!="pending": raise ValueError("Candidate not pending")
            if action=="reject":
                db.execute("UPDATE cog_candidates SET state='rejected' WHERE id=?",(ident,));emit(db,"review","Кандидат отклонён");return
            if memory.active_conflict(db,c["subject"],c["fingerprint"]):
                if data.get("confirm_conflict") is not True: raise ValueError("Есть другое утверждение о том же предмете. Подтвердите сохранение обоих.")
            existing=memory.existing(db,c["title"],TYPES[c["kind"]])
            node=existing[0] if existing else db.execute("INSERT INTO nodes(title,category,folder,created_at) VALUES(?,?,?,?)",(c["title"],TYPES[c["kind"]],"Память",now())).lastrowid
            db.execute("INSERT INTO cog_memory(node_id,kind,subject,fingerprint,source,at,confidence,priority) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(node_id) DO UPDATE SET subject=excluded.subject,priority=MAX(cog_memory.priority,excluded.priority)",(node,c["kind"],c["subject"],c["fingerprint"],c["source"],c["at"],c["confidence"],c["priority"]))
            db.execute("UPDATE cog_candidates SET state='approved' WHERE id=?",(ident,))
            if not existing: db.execute("INSERT INTO atlas_events(at,kind,detail) VALUES(?,?,?)",(now(),"node",c["title"]))
            emit(db,"memory","Кандидат принят пользователем",node)
            if memory.table(db,"evo_journal"): evolution.log(db,"memory","Подтверждена запись #%d"%node)
def relation(path,data):
    a,b,kind,action=data.get("source"),data.get("target"),data.get("kind"),data.get("action")
    if type(a) is not int or type(b) is not int or a==b or kind not in ("association","duplicate","cause") or action not in ("approve","reject"): raise ValueError("Invalid relation")
    if kind!="cause": a,b=sorted((a,b))
    with closing(connect(path)) as db:
        init(db)
        with db:
            if db.execute("SELECT COUNT(*) FROM nodes WHERE id IN (?,?)",(a,b)).fetchone()[0]!=2: raise ValueError("Unknown records")
            db.execute("BEGIN IMMEDIATE")
            if kind=="cause" and action=="approve":
                cycle=db.execute("WITH RECURSIVE reach(id) AS (SELECT ? UNION SELECT r.target FROM cog_relations r JOIN reach ON r.source=reach.id WHERE r.kind='cause' AND r.state='approved') SELECT 1 FROM reach WHERE id=?",(b,a)).fetchone()
                if cycle: raise ValueError("Циклическая причинная связь запрещена")
                db.execute("INSERT OR IGNORE INTO cog_relations(source,target,kind,evidence) VALUES(?,?,?,?)",(a,b,kind,"Причина указана пользователем"))
            if not db.execute("UPDATE cog_relations SET state=? WHERE source=? AND target=? AND kind=?",("approved" if action=="approve" else "rejected",a,b,kind)).rowcount: raise ValueError("Unknown relation")
            if action=="approve" and kind!="duplicate":
                changed=db.execute("INSERT OR IGNORE INTO edges VALUES(?,?)",tuple(sorted((a,b)))).rowcount
                if changed: db.execute("INSERT INTO atlas_events(at,kind,detail) VALUES(?,?,?)",(now(),"edge",f"Связь {a} → {b}"))
                emit(db,"relation","Подтверждена связь: "+kind,a)
            elif kind=="duplicate" and action=="approve":
                rows=db.execute("SELECT id,title,category FROM nodes WHERE id IN (?,?) ORDER BY id",(a,b)).fetchall()
                if memory.table(db,"documents") and db.execute("SELECT 1 FROM documents WHERE node_id IN (?,?)",(a,b)).fetchone(): raise ValueError("Файловые записи нельзя объединять по имени")
                if norm(rows[0]["title"])!=norm(rows[1]["title"]) or rows[0]["category"]!=rows[1]["category"]: raise ValueError("Only exact normalized duplicates can be grouped")
                canonical,other=sorted((memory.canonical(db,a),memory.canonical(db,b)))
                if canonical!=other:
                    db.execute("UPDATE cog_aliases SET canonical_id=? WHERE canonical_id=?",(canonical,other))
                    db.execute("INSERT INTO cog_aliases VALUES(?,?) ON CONFLICT(alias_id) DO UPDATE SET canonical_id=excluded.canonical_id",(other,canonical))
                emit(db,"review","Дубликат объединён в поиске; исходные записи и связи сохранены",canonical)
            elif kind=="duplicate" and action=="reject":
                if memory.canonical(db,a)==memory.canonical(db,b): raise ValueError("Подтверждённая группа сохраняется; разъединение требует отдельной операции")
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
                if memory.table(db,"evo_journal"): evolution.log(db,"feedback","Ответ оценён: "+("полезно" if helpful else "не помогло"))
def lookup(path,q,record=False):
    if not isinstance(q,str) or not q.strip() or len(q)>300: raise ValueError("Invalid query")
    with closing(connect(path)) as db:
        init(db)
        results=memory.search(db,q,"Qwen/Qwen3-Embedding-0.6B")
        for r in results:r["state"]=memory.current_state(db,r["id"]);r["freshness"]=evolution.freshness(db,r["id"])
        if record:
            with db:
                if memory.table(db,"evo_journal"): evolution.log(db,"recall","Извлечено записей: %d"%len(results))
                for r in results: db.execute("UPDATE cog_memory SET recall_count=recall_count+1 WHERE node_id=?",(r["id"],));emit(db,"recall","Извлечена локальная запись",r["id"])
        return {"results":results,"coverage":"Весь атлас; слова и доступные локальные векторы","missing":not bool(results),"intent":intent(q)}
def dashboard(path,light=False):
    with closing(connect(path)) as db:
        init(db)
        st=dict(db.execute("SELECT * FROM cog_state WHERE id=1").fetchone())
        revision=db.execute("SELECT version FROM atlas_revision WHERE id=1").fetchone()[0] if memory.table(db,"atlas_revision") else 0
        if light:
            return {"state":st,"revision":revision,"health":{"nodes":db.execute("SELECT COUNT(*) FROM nodes").fetchone()[0],"edges":db.execute("SELECT COUNT(*) FROM edges").fetchone()[0],"pending":db.execute("SELECT COUNT(*) FROM cog_candidates WHERE state='pending'").fetchone()[0]},"skills":[dict(r) for r in db.execute("SELECT * FROM cog_skills ORDER BY name")],"events":[dict(r) for r in db.execute("SELECT * FROM cog_events ORDER BY id DESC LIMIT 30")]}
        candidates=[{**dict(r),"conflict":int(memory.active_conflict(db,r["subject"],r["fingerprint"]))} for r in db.execute("SELECT * FROM cog_candidates WHERE state='pending' ORDER BY id DESC LIMIT 50")]
        rejected=[dict(r) for r in db.execute("SELECT id,title FROM cog_candidates WHERE state='rejected' ORDER BY id DESC LIMIT 20")]
        relations=[dict(r) for r in db.execute("SELECT r.*,a.title source_title,b.title target_title FROM cog_relations r JOIN nodes a ON a.id=r.source JOIN nodes b ON b.id=r.target WHERE r.state='suggested' ORDER BY r.source DESC LIMIT 30")]
        counts={r[0]:r[1] for r in db.execute("SELECT kind,COUNT(*) FROM cog_memory GROUP BY kind")}
        health={"foreign_key_issues":sum(1 for _ in db.execute("PRAGMA foreign_key_check")),"pending":db.execute("SELECT COUNT(*) FROM cog_candidates WHERE state='pending'").fetchone()[0],"nodes":db.execute("SELECT COUNT(*) FROM nodes").fetchone()[0],"edges":db.execute("SELECT COUNT(*) FROM edges").fetchone()[0]}
        return {"state":st,"revision":revision,"persona":PERSONA,"counts":counts,"health":health,"candidates":candidates,"rejected":rejected,"relations":relations,"skills":[dict(r) for r in db.execute("SELECT * FROM cog_skills ORDER BY name")],"goals":[dict(r) for r in db.execute("SELECT * FROM cog_goals ORDER BY id LIMIT 20")],"events":[dict(r) for r in db.execute("SELECT * FROM cog_events ORDER BY id DESC LIMIT 30")]}
def system_profile(path,prompt):
    # Only fixed persona and approved style, never local memories or user preferences.
    with closing(connect(path)) as db:
        init(db);style=db.execute("SELECT style FROM cog_state WHERE id=1").fetchone()[0]
    return " You portray Amatsumireika, a fictional celestial kitsune empress. Be accurate, respectful, and clear about limitations. Do not claim consciousness. Speech style: "+style+". User request category: "+intent(prompt)+"."

def adaptive_plan(path,text,db=None):
    result=plan(text)
    def enrich(conn):
        if memory.table(conn,"cog_skills"):
            failures=conn.execute("SELECT COALESCE(SUM(failures),0) FROM cog_skills").fetchone()[0]
            if failures and result["intent"] in ("repair","search"):
                result["steps"].insert(0,"Проверить прошлые неудачные операции и не повторять их без проверки")
        if memory.table(conn,"evo_versions") and len(text.strip())<=300:
            found=evolution.retrieve(conn,text,active_only=True)["experience"]
            result["experience"]=[{"id":r["id"],"title":r["title"]} for r in found]
            if found:result["steps"].insert(0,"Проверить применимость сохранённого опыта: "+found[0]["title"])
        return result
    if db is not None:return enrich(db)
    with closing(connect(path)) as conn:return enrich(conn)
