"""Local, extractive document intelligence; evidence is not a factual verdict."""
from bisect import bisect_left
from collections import Counter, defaultdict
from contextlib import closing
import difflib
import json
import math
import re
import documents as doc
import memory_engine as memory

MAX_FRAGMENT=800
MAX_RESULTS=16
LABEL=re.compile(r"\s*(факт|событие|навык|привычка|предпочтение|причина|цель|запомни)\s*[:：]\s*(.+)",re.I)
FACT=re.compile(r"\s*факт\s*[:：]\s*([^=:]{1,80})\s*[=:]\s*(.{1,120})",re.I)
HEADING=re.compile(r"^\s*(?:#{1,6}\s+\S|(?:глава|раздел|приложение|chapter|section)\s+\S|xl/worksheets/sheet\d+\.xml\s*$)",re.I)
RULES={
    "Договоры":("договор","контракт","соглашен","сторон","поставщик","обязательств","contract","agreement"),
    "Автотранспорт":("автомоб","двигател","топлив","гараж","запчаст","пробег","ремонт","водител","vehicle","engine"),
    "Бухгалтерия":("счет","счёт","налог","оплат","бухгалтер","накладн","сумма","invoice","payment"),
    "Кадры":("табел","сотрудник","отпуск","приказ","заработ","график","employee","payroll"),
    "Технические документы":("инструкц","оборудован","техническ","спецификац","параметр","устройств","manual","technical"),
    "Отчёты":("отчет","отчёт","показател","статистик","итог","аналитик","report","summary"),
}
def init(db):
    statements=(
        """CREATE TABLE IF NOT EXISTS doc_fragment_state(document_id INTEGER PRIMARY KEY REFERENCES documents(id),text_sha TEXT NOT NULL,fragment_count INTEGER NOT NULL,indexed_at TEXT NOT NULL)""",
        """CREATE TABLE IF NOT EXISTS doc_fragments(document_id INTEGER NOT NULL REFERENCES documents(id),seq INTEGER NOT NULL,start_offset INTEGER NOT NULL,end_offset INTEGER NOT NULL,line_start INTEGER NOT NULL,line_end INTEGER NOT NULL,section TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(document_id,seq))""",
        """CREATE TABLE IF NOT EXISTS doc_fragment_terms(term TEXT NOT NULL,document_id INTEGER NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(term,document_id,seq),FOREIGN KEY(document_id,seq) REFERENCES doc_fragments(document_id,seq) ON DELETE CASCADE)""",
        """CREATE INDEX IF NOT EXISTS doc_fragment_terms_by_fragment ON doc_fragment_terms(document_id,seq)""",
        """CREATE TABLE IF NOT EXISTS doc_claims(document_id INTEGER NOT NULL REFERENCES documents(id),start_offset INTEGER NOT NULL,end_offset INTEGER NOT NULL,line INTEGER NOT NULL,subject TEXT NOT NULL,value TEXT NOT NULL,quote TEXT NOT NULL,PRIMARY KEY(document_id,start_offset))""",
        """CREATE INDEX IF NOT EXISTS doc_claim_subject ON doc_claims(subject,document_id,start_offset)""",
        """CREATE TABLE IF NOT EXISTS doc_source_quotes(document_id INTEGER NOT NULL REFERENCES documents(id),fingerprint TEXT NOT NULL,text_sha TEXT NOT NULL,start_offset INTEGER NOT NULL,end_offset INTEGER NOT NULL,line INTEGER NOT NULL,quote TEXT NOT NULL,captured_at TEXT NOT NULL,method TEXT NOT NULL,PRIMARY KEY(document_id,fingerprint,text_sha,start_offset))""",
        """CREATE INDEX IF NOT EXISTS doc_source_quotes_fingerprint ON doc_source_quotes(fingerprint,document_id)""",
        """CREATE TABLE IF NOT EXISTS doc_classification(document_id INTEGER PRIMARY KEY REFERENCES documents(id),category TEXT NOT NULL,tags TEXT NOT NULL,text_sha TEXT NOT NULL,approved_at TEXT NOT NULL)""",
        """CREATE TRIGGER IF NOT EXISTS doc_fragment_invalidate AFTER UPDATE OF content,extract_status ON documents WHEN OLD.content<>NEW.content OR OLD.extract_status<>NEW.extract_status BEGIN DELETE FROM doc_fragment_terms WHERE document_id=NEW.id; DELETE FROM doc_fragments WHERE document_id=NEW.id; DELETE FROM doc_claims WHERE document_id=NEW.id; DELETE FROM doc_fragment_state WHERE document_id=NEW.id; END""",
    )
    for sql in statements:db.execute(sql)

def split_text(text):
    """Exact character ranges in extracted text, not invented physical page numbers."""
    breaks=[m.end()-1 for m in re.finditer(r"\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]",text)]
    blocks=[];start=None;end=0;section="";block_section=""
    def emit(a,b,heading):
        while a<b and text[a].isspace():a+=1
        while b>a and text[b-1].isspace():b-=1
        while a<b:
            stop=min(b,a+MAX_FRAGMENT)
            if stop<b:
                boundary=max(text.rfind(" ",a+MAX_FRAGMENT//2,stop),text.rfind("\n",a+MAX_FRAGMENT//2,stop))
                if boundary>a:stop=boundary
            body=text[a:stop]
            blocks.append({"seq":len(blocks)+1,"start_offset":a,"end_offset":stop,"line_start":bisect_left(breaks,a)+1,"line_end":bisect_left(breaks,stop-1)+1,"section":heading,"body":body})
            a=stop
            while a<b and text[a].isspace():a+=1
    offset=0
    for raw in text.splitlines(keepends=True):
        if len(blocks)>2000:
            # Pathological tiny paragraphs: preserve full text with bounded windows.
            blocks.clear();emit(0,len(text),"");return blocks
        line=raw.rstrip("\r\n\v\f\x1c\x1d\x1e\x85\u2028\u2029");line_end=offset+len(line)
        heading=bool(HEADING.match(line))
        if not line.strip() or heading or (start is not None and line_end-start>MAX_FRAGMENT):
            if start is not None:emit(start,end,block_section);start=None
        if heading:section=line.strip()[:160]
        if line.strip():
            if start is None:start=offset;block_section=section
            end=line_end
            if end-start>=MAX_FRAGMENT:emit(start,end,block_section);start=None
        offset+=len(raw)
    if start is not None:emit(start,end,block_section)
    return blocks

def lines(text):
    offset=0
    for number,raw in enumerate(text.splitlines(keepends=True),1):
        line=raw.rstrip("\r\n\v\f\x1c\x1d\x1e\x85\u2028\u2029")
        yield number,offset,line
        offset+=len(raw)

def claims(text):
    for number,offset,line in lines(text):
        m=FACT.fullmatch(line)
        if m:
            yield {"line":number,"start_offset":offset,"end_offset":offset+len(line),"subject":memory.norm(m[1]),"value":memory.norm(m[2]),"quote":line}

def capture(db,ident,fingerprint,text,number,offset,line,method="captured"):
    db.execute("INSERT OR IGNORE INTO doc_source_quotes VALUES(?,?,?,?,?,?,?,?,?)",(ident,fingerprint,memory.digest(text),offset,offset+len(line),number,line,doc.now(),method))

def index_document(db,ident):
    r=doc.get(db,ident,False)
    if r["extract_status"]!="indexed":return False
    content=r["content"]
    digest=memory.digest(content)
    old=db.execute("SELECT text_sha FROM doc_fragment_state WHERE document_id=?",(ident,)).fetchone()
    if old and old[0]==digest:return False
    db.execute("DELETE FROM doc_fragment_terms WHERE document_id=?",(ident,))
    db.execute("DELETE FROM doc_fragments WHERE document_id=?",(ident,))
    db.execute("DELETE FROM doc_claims WHERE document_id=?",(ident,))
    blocks=split_text(content)
    for b in blocks:
        db.execute("INSERT INTO doc_fragments VALUES(?,?,?,?,?,?,?,?)",(ident,b["seq"],b["start_offset"],b["end_offset"],b["line_start"],b["line_end"],b["section"],b["body"]))
        db.executemany("INSERT OR IGNORE INTO doc_fragment_terms VALUES(?,?,?)",((t,ident,b["seq"]) for t in memory.terms(b["body"]) if len(t)<=80))
    db.executemany("INSERT INTO doc_claims VALUES(?,?,?,?,?,?,?)",((ident,c["start_offset"],c["end_offset"],c["line"],c["subject"],c["value"],c["quote"]) for c in claims(content)))
    # Older provenance may be reconstructed only when the exact labeled line and
    # already-recorded source fingerprint agree. No invented historical timestamp.
    if memory.table(db,"document_sources"):
        known={x[0] for x in db.execute("SELECT fingerprint FROM document_sources WHERE document_id=?",(ident,))}
        if known:
            import cognitive
            for number,offset,line in lines(content):
                m=LABEL.fullmatch(line)
                if m and cognitive.safe(m[2].strip()):
                    fp=cognitive.digest(cognitive.LABELS[m[1].casefold()]+"\0"+m[2].strip())
                    if fp in known:capture(db,ident,fp,content,number,offset,line,"reconstructed_match")
    db.execute("INSERT OR REPLACE INTO doc_fragment_state VALUES(?,?,?,?)",(ident,digest,len(blocks),doc.now()))
    return True

def backfill_one(db):
    row=db.execute("SELECT d.id FROM documents d WHERE d.deleted IS NULL AND d.extract_status='indexed' AND NOT EXISTS(SELECT 1 FROM doc_fragment_state s WHERE s.document_id=d.id) ORDER BY d.id LIMIT 1").fetchone()
    return index_document(db,row[0]) if row else False

def pending(db):
    return db.execute("SELECT COUNT(*) FROM documents d WHERE d.deleted IS NULL AND d.extract_status='indexed' AND NOT EXISTS(SELECT 1 FROM doc_fragment_state s WHERE s.document_id=d.id)").fetchone()[0]

def rank(body,terms,phrase,weights):
    tokens=memory.terms(body);hits=terms&tokens
    if not hits:return 0,0
    weight=sum(weights.get(x,1) for x in hits)
    score=weight/max(1,sum(weights.get(x,1) for x in terms))+.25*len(hits)/max(1,math.sqrt(len(tokens)))+(.35 if phrase and phrase in memory.norm(body) else 0)
    return round(score,5),len(hits)

def search(path,query,ident=None):
    if not isinstance(query,str) or not query.strip() or len(query)>300:raise ValueError("Укажите вопрос до 300 символов")
    terms={x for x in memory.terms(query) if len(x)<=80}
    if not terms:return {"sources":[],"fragments":[],"pending":0}
    marks=",".join("?" for _ in terms);args=sorted(terms);phrase=memory.norm(query)
    with closing(doc.connect(path)) as db:
        db.execute("BEGIN")
        if ident is not None:doc.get(db,ident)
        total=db.execute("SELECT COUNT(*) FROM doc_fragments f JOIN documents d ON d.id=f.document_id WHERE d.deleted IS NULL AND d.extract_status='indexed'").fetchone()[0]
        weights={r[0]:1+math.log((1+total)/(1+r[1])) for r in db.execute("SELECT t.term,COUNT(*) FROM doc_fragment_terms t JOIN documents d ON d.id=t.document_id WHERE d.deleted IS NULL AND d.extract_status='indexed' AND t.term IN ("+marks+") GROUP BY t.term",args)}
        scope=" AND d.id=?" if ident is not None else ""
        rows=db.execute("SELECT f.*,d.name,d.sha256,s.text_sha,h.hits FROM (SELECT t.document_id,t.seq,COUNT(*) hits FROM doc_fragment_terms t JOIN documents d ON d.id=t.document_id WHERE d.deleted IS NULL AND d.extract_status='indexed' AND t.term IN ("+marks+")"+scope+" GROUP BY t.document_id,t.seq ORDER BY hits DESC,t.document_id,t.seq LIMIT 401) h JOIN doc_fragments f ON f.document_id=h.document_id AND f.seq=h.seq JOIN documents d ON d.id=f.document_id JOIN doc_fragment_state s ON s.document_id=d.id ORDER BY h.hits DESC,d.id,f.seq",args+([ident] if ident is not None else [])).fetchall()
        def result(r,b,digest):
            score,hits=rank(b["body"],terms,phrase,weights)
            if not hits:return None
            return {"id":r["id"] if "id" in r.keys() else r["document_id"],"name":r["name"],"sha256":r["sha256"],"text_sha":digest,"excerpt":b["body"],"matches":hits,"score":score,**{k:b[k] for k in ("seq","start_offset","end_offset","line_start","line_end","section")}}
        found=[result(r,r,r["text_sha"]) for r in rows[:400]]
        # Legacy documents remain searchable while bounded migration is running.
        old=db.execute("SELECT d.* FROM documents d WHERE d.deleted IS NULL AND d.extract_status='indexed' AND NOT EXISTS(SELECT 1 FROM doc_fragment_state s WHERE s.document_id=d.id) AND d.id IN(SELECT document_id FROM document_terms WHERE term IN ("+marks+"))"+scope+" ORDER BY d.id LIMIT 31",args+([ident] if ident is not None else [])).fetchall()
        for r in old[:30]:
            digest=memory.digest(r["content"])
            found.extend(result(r,b,digest) for b in split_text(r["content"]))
        found=[x for x in found if x]
        found.sort(key=lambda x:(-x["score"],-x["matches"],x["id"],x["seq"]))
        best=[];seen=set()
        for x in found:
            if x["id"] not in seen:best.append(x);seen.add(x["id"])
            if len(best)>=8:break
        return {"sources":best,"fragments":found[:MAX_RESULTS],"pending":pending(db),"bounded":len(rows)>400 or len(old)>30,"method":"weighted lexical fragments; exact extracted text"}

def related(db,r):
    if r["extract_status"]!="indexed":return []
    keys=Counter(t for t in re.findall(r"\w{3,}",memory.norm(r["content"])) if t not in memory.STOP)
    q=[t for t,_ in keys.most_common(18) if len(t)<=80]
    if not q:return []
    marks=",".join("?" for _ in q)
    rows=db.execute("SELECT d.id,d.node_id,d.name,d.folder,d.content,COUNT(*) hits FROM document_terms t JOIN documents d ON d.id=t.document_id WHERE d.id<>? AND d.deleted IS NULL AND d.extract_status='indexed' AND t.term IN ("+marks+") GROUP BY d.id ORDER BY hits DESC,d.id LIMIT 60",[r["id"]]+q).fetchall()
    output=[];qset=set(q)
    for other in rows:
        best=None
        for block in split_text(other["content"]):
            hits=qset&memory.terms(block["body"])
            if hits and (best is None or len(hits)>len(best[0])):best=(hits,block)
        if not best:continue
        hits,block=best
        shared=qset&memory.terms(other["content"])
        score=.65*len(shared)/len(qset)+.35*len(hits)/len(qset)
        output.append({"id":other["id"],"node_id":other["node_id"],"name":other["name"],"folder":other["folder"],"score":round(score,3),"shared":sorted(shared),"excerpt":block["body"][:MAX_FRAGMENT],"line_start":block["line_start"],"line_end":block["line_end"],"start_offset":block["start_offset"],"end_offset":block["end_offset"],"method":"content_keyword_overlap"})
    return sorted(output,key=lambda x:(-x["score"],x["id"]))[:20]

def conflicts(db,r):
    if r["extract_status"]!="indexed":return []
    local=list(claims(r["content"]));by_subject=defaultdict(list)
    for c in local:by_subject[c["subject"]].append(c)
    output=[]
    for subject,own in list(by_subject.items())[:40]:
        values={x["value"] for x in own}
        if len(values)>1:output.append({"subject":subject,"document":r["id"],"kind":"внутреннее расхождение","values":sorted(values),"quote":own[0]["quote"],"line":own[0]["line"],"start_offset":own[0]["start_offset"],"end_offset":own[0]["end_offset"],"reference_quote":next(x["quote"] for x in own if x["value"]!=own[0]["value"])})
        others=db.execute("SELECT c.* FROM doc_claims c JOIN documents d ON d.id=c.document_id WHERE c.subject=? AND c.document_id<>? AND d.deleted IS NULL AND d.extract_status='indexed' ORDER BY c.document_id,c.start_offset LIMIT 101",(subject,r["id"])).fetchall()
        # Prefer mismatches over matching values; all are explicit claim comparisons.
        for x in sorted(others[:100],key=lambda x:(x["value"] in values,x["document_id"],x["start_offset"])):
            output.append({"subject":subject,"document":x["document_id"],"kind":"совпадение" if x["value"] in values else "возможное противоречие","values":[x["value"]],"quote":x["quote"],"line":x["line"],"start_offset":x["start_offset"],"end_offset":x["end_offset"],"reference_quote":own[0]["quote"]})
        if len(output)>=80:break
    return output[:80]

def classification(r):
    tokens=memory.terms(r["name"]+" "+(r["content"] if r["extract_status"]=="indexed" else ""))
    ranking=[]
    for category,prefixes in RULES.items():
        matched=sorted(t for t in tokens if any(t.startswith(p) for p in prefixes))
        rules=sum(any(t.startswith(p) for t in tokens) for p in prefixes)
        if rules:ranking.append({"category":category,"folder":category,"hits":rules,"evidence":matched[:12]})
    ranking.sort(key=lambda x:(-x["hits"],x["category"]))
    text=r["content"] if r["extract_status"]=="indexed" else ""
    tags=[t for t,_ in Counter(t for t in re.findall(r"\w{3,}",memory.norm(text)) if t not in memory.STOP and len(t)<=80).most_common(12)]
    return {"suggested":ranking[:4],"tags":tags,"method":"local rules, not verified classification"}

def classification_state(db,r):
    result=classification(r)
    saved=db.execute("SELECT category,tags,text_sha,approved_at FROM doc_classification WHERE document_id=?",(r["id"],)).fetchone()
    result["approved"]={**dict(saved),"tags":json.loads(saved["tags"]),"current":saved["text_sha"]==memory.digest(r["content"])} if saved else None
    return result

def approve_classification(path,data):
    if data.get("confirm") is not True:raise ValueError("Подтвердите классификацию")
    with closing(doc.connect(path)) as db,db:
        db.execute("BEGIN IMMEDIATE")
        r=doc.get(db,data.get("id"))
        result=classification(r);category=data.get("category")
        if category not in {x["category"] for x in result["suggested"]}:raise ValueError("Категория не предложена для текущего документа")
        db.execute("INSERT OR REPLACE INTO doc_classification VALUES(?,?,?,?,?)",(r["id"],category,json.dumps(result["tags"],ensure_ascii=False),memory.digest(r["content"]),doc.now()))
        doc.event(db,r["id"],"Классификация подтверждена: "+category,r["node_id"])
        return classification_state(db,r)

def provenance(db,r):
    current=memory.digest(r["content"])
    rows=db.execute("""SELECT q.*,s.node_id,c.state,COALESCE(n.title,c.title,'') title FROM doc_source_quotes q LEFT JOIN document_sources s ON s.document_id=q.document_id AND s.fingerprint=q.fingerprint LEFT JOIN cog_candidates c ON c.fingerprint=q.fingerprint LEFT JOIN nodes n ON n.id=s.node_id WHERE q.document_id=? ORDER BY (q.text_sha=?) DESC,q.start_offset,q.captured_at DESC LIMIT 100""",(r["id"],current)).fetchall()
    return [{**dict(x),"current":r["extract_status"]=="indexed" and x["text_sha"]==current and r["content"][x["start_offset"]:x["end_offset"]]==x["quote"]} for x in rows]

def compare(path,child,parent=None):
    with closing(doc.connect(path)) as db:
        db.execute("BEGIN")
        new=doc.get(db,child)
        if parent is None:
            oldid=db.execute("SELECT parent FROM document_versions WHERE child=?",(child,)).fetchone()
            if not oldid:raise ValueError("Нет подтверждённой предыдущей редакции")
            parent=oldid[0]
        old=doc.get(db,parent)
        if child==parent:raise ValueError("Выберите разные документы")
        if new["extract_status"]!="indexed" or old["extract_status"]!="indexed":raise ValueError("Обе редакции должны иметь текстовый индекс")
        left=old["content"].splitlines();right=new["content"].splitlines()
        # Keep worst-case diff cost bounded; explicitly label any partial coverage.
        cap=2000;a,b=left[:cap],right[:cap]
        changes=[];counts={"added":0,"removed":0,"replaced_before":0,"replaced_after":0}
        change_count=0
        for op,i,j,k,l in difflib.SequenceMatcher(None,a,b,autojunk=True).get_opcodes():
            if op=="equal":continue
            change_count+=1
            if op=="insert":counts["added"]+=l-k
            elif op=="delete":counts["removed"]+=j-i
            else:counts["replaced_before"]+=j-i;counts["replaced_after"]+=l-k
            if len(changes)<50:changes.append({"operation":op,"before_line":i+1,"after_line":k+1,"before":"\n".join(a[i:j])[:1200],"after":"\n".join(b[k:l])[:1200],"before_count":j-i,"after_count":l-k})
        def values(text):
            out=defaultdict(set)
            for c in claims(text):out[c["subject"]].add(c["value"])
            return out
        before,after=values(old["content"]),values(new["content"])
        facts=[{"subject":s,"before":sorted(before[s]),"after":sorted(after[s])} for s in sorted(before.keys()|after.keys()) if before[s]!=after[s]]
        return {"child":child,"parent":parent,"confirmed_version":bool(db.execute("SELECT 1 FROM document_versions WHERE child=? AND parent=?",(child,parent)).fetchone()),"counts":counts,"changes":changes,"claim_changes":facts[:100],"omitted_changes":max(0,change_count-50),"omitted_claim_changes":max(0,len(facts)-100),"partial":len(left)>cap or len(right)>cap or len(old["content"])>=doc.MAX_TEXT or len(new["content"])>=doc.MAX_TEXT,"scope":"extracted text, not original document layout; claims require review"}
