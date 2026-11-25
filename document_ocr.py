"""Opt-in Windows OCR; no cloud calls or package installation."""
from contextlib import closing
from pathlib import Path
import json
import os
import subprocess
import tempfile
from threading import Lock
import documents as doc
import memory_engine as memory

LOCK=Lock()
EXT={".png",".jpg",".jpeg",".pdf",".gif",".webp"}

def recognize(name,raw):
    if os.name!="nt":
        raise ValueError("OCR доступно только в Windows с установленным языком распознавания")
    script=Path(__file__).resolve().with_name("document_ocr.ps1")
    system=Path(os.environ.get("SystemRoot",r"C:\Windows"))
    powershell=system/"System32"/"WindowsPowerShell"/"v1.0"/"powershell.exe"
    with tempfile.TemporaryDirectory(prefix="atlas-ocr-") as tmp:
        f=Path(tmp)/("input"+Path(name).suffix.lower())
        f.write_bytes(raw)
        out=Path(tmp)/"result.json"
        try:
            p=subprocess.run([str(powershell),"-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",str(script),"-Path",str(f),"-OutputPath",str(out)],capture_output=True,timeout=45,check=True,creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0))
            if out.stat().st_size>2*1024*1024:raise ValueError("OCR output exceeds limit")
            result=json.loads(out.read_text(encoding="utf-8-sig"))
            if not isinstance(result,dict) or not isinstance(result.get("text"),str) or type(result.get("pages")) is not int or type(result.get("total")) is not int or not 1<=result["pages"]<=min(10,result["total"]):
                raise ValueError("Некорректный результат OCR")
            return result
        except (OSError,subprocess.SubprocessError,UnicodeError,ValueError) as exc:
            raise ValueError("OCR недоступно или не завершилось: проверьте язык Windows и формат файла") from exc

def run(path,ident):
    if not LOCK.acquire(False):raise ValueError("OCR уже выполняется")
    try:
        with closing(doc.connect(path)) as db:
            row=doc.get(db,ident)
            if row["extract_status"] not in ("preview_only","empty_text","extraction_failed"):
                raise ValueError("OCR не заменяет существующий текст или активную индексацию")
            if Path(row["name"]).suffix.lower() not in EXT:raise ValueError("OCR не поддерживает этот формат")
        name,raw=doc.binary(path,ident)
        result=recognize(name,raw)
        content=result["text"].strip()[:doc.MAX_TEXT]
        if not content:return {"indexed":False,"pages":result["pages"],"total":result["total"]}
        with closing(doc.connect(path)) as db,db:
            db.execute("BEGIN IMMEDIATE")
            current=doc.get(db,ident)
            if current["sha256"]!=row["sha256"] or current["extract_status"]!=row["extract_status"]:raise ValueError("Документ изменился во время OCR")
            job=db.execute("SELECT status FROM document_jobs WHERE document_id=?",(ident,)).fetchone()
            if job and job[0] in ("queued","running"):raise ValueError("Индексация выполняется")
            db.execute("UPDATE documents SET content=?,extract_status='indexed' WHERE id=?",(content,ident))
            db.execute("DELETE FROM document_terms WHERE document_id=?",(ident,))
            db.executemany("INSERT OR IGNORE INTO document_terms VALUES(?,?)",((t,ident) for t in memory.terms(name+" "+current["folder"]+" "+content) if len(t)<=80))
            if job:db.execute("UPDATE document_jobs SET status='done',error='',updated=? WHERE document_id=?",(doc.now(),ident))
            doc.event(db,ident,"OCR Windows: "+str(result["pages"])+"/"+str(result["total"])+" стр.; текст требует проверки",current["node_id"])
        return {"indexed":True,"pages":result["pages"],"total":result["total"],"truncated":len(result["text"].strip())>doc.MAX_TEXT}
    finally:LOCK.release()


THUMB_LOCK=Lock()
THUMBS={}
def pdf_thumbnail(path,ident):
    if os.name!="nt":raise ValueError("Миниатюры PDF доступны в Windows")
    name,raw=doc.binary(path,ident)
    if Path(name).suffix.lower()!=".pdf":raise ValueError("Не PDF")
    key=__import__("hashlib").sha256(raw).hexdigest()
    if not THUMB_LOCK.acquire(False):raise ValueError("Миниатюра уже создаётся")
    try:
        if key in THUMBS:return THUMBS[key]
        script=Path(__file__).resolve().with_name("document_ocr.ps1")
        powershell=Path(os.environ.get("SystemRoot",r"C:\Windows"))/"System32"/"WindowsPowerShell"/"v1.0"/"powershell.exe"
        with tempfile.TemporaryDirectory(prefix="atlas-thumb-") as tmp:
            f=Path(tmp)/"input.pdf";f.write_bytes(raw)
            out=Path(tmp)/"thumbnail.png"
            try:
                p=subprocess.run([str(powershell),"-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",str(script),"-Path",str(f),"-OutputPath",str(out),"-Thumbnail"],capture_output=True,timeout=15,check=True,creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0))
                if not 8<=out.stat().st_size<=1048576:raise ValueError("Invalid PNG size")
                img=out.read_bytes()
                if not img.startswith(b"\x89PNG\r\n\x1a\n") or len(img)>1048576:raise ValueError("Invalid PNG")
            except (OSError,subprocess.SubprocessError,ValueError) as exc:raise ValueError("Миниатюра PDF недоступна") from exc
        if len(THUMBS)>=32:THUMBS.pop(next(iter(THUMBS)))
        THUMBS[key]=img
        return img

    finally:THUMB_LOCK.release()
