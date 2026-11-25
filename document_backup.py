"""Explicit backup of database and immutable referenced originals."""
from contextlib import closing
from pathlib import Path
import hashlib
import json
import sqlite3
import tempfile
import zipfile
import os
from threading import Lock
import documents as doc
LOCK=Lock()
def backup(path):
    if not LOCK.acquire(False):raise ValueError("Резервирование уже выполняется")
    try:
        base=path.parent/"backups";base.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as tmp:
            temp=Path(tmp);dbcopy=temp/"database.sqlite";archive=temp/"backup.zip"
            with closing(doc.connect(path)) as source, closing(sqlite3.connect(dbcopy)) as dest:
                source.backup(dest)
                rows=dest.execute("SELECT id,blob,sha256,size FROM documents ORDER BY id").fetchall()
            with zipfile.ZipFile(archive,"w",compression=zipfile.ZIP_STORED,allowZip64=True) as z:
                z.write(dbcopy,"database.sqlite")
                for ident,blob,sha,size in rows:
                    file=doc.path_for(path,blob)
                    if not file.is_file() or file.stat().st_size!=size:raise ValueError("Нет оригинала #"+str(ident))
                    raw=file.read_bytes()
                    if hashlib.sha256(raw).hexdigest()!=sha:raise ValueError("Повреждён оригинал #"+str(ident))
                    z.writestr("files/"+blob,raw)
                z.writestr("manifest.json",json.dumps({"schema":1,"created":doc.now(),"files":[{"id":i,"blob":b,"sha256":s,"size":n} for i,b,s,n in rows]},ensure_ascii=False))
            name="documents-"+doc.now().replace(":","-").replace("+","_")+".zip"
            final=base/name
            os.replace(archive,final)
            return {"name":name,"files":len(rows),"bytes":final.stat().st_size}
    finally:LOCK.release()


def repair(path):
    """Repair only originals whose exact size and hash match the live database.
    Never replace the live database or silently restore deleted records."""
    if not LOCK.acquire(False):raise ValueError("Резервирование или восстановление уже выполняется")
    try:
        base=path.parent/"backups"
        archives=sorted((p for p in base.glob("documents-*.zip") if p.is_file() and not p.is_symlink()),reverse=True)[:30]
        repaired=[];unresolved=[];quarantine=[]
        with closing(doc.connect(path)) as db,db:
            db.execute("BEGIN IMMEDIATE")
            rows=db.execute("SELECT id,node_id,blob,sha256,size FROM documents ORDER BY id").fetchall()
            for r in rows:
                ident=r["id"]
                try:
                    target=doc.path_for(path,r["blob"])
                    size=r["size"]
                    if not 0<size<=doc.MAX_BYTES:raise ValueError("Invalid document size")
                    if target.is_file() and target.stat().st_size==size and hashlib.sha256(target.read_bytes()).hexdigest()==r["sha256"]:continue
                    raw=None
                    for archive in archives:
                        try:
                            with zipfile.ZipFile(archive) as z:
                                info=z.getinfo("files/"+r["blob"])
                                if info.file_size!=size or info.is_dir():continue
                                candidate=z.read(info)
                                if len(candidate)==size and hashlib.sha256(candidate).hexdigest()==r["sha256"]:
                                    raw=candidate;break
                        except (OSError,KeyError,ValueError,RuntimeError,zipfile.BadZipFile,NotImplementedError):continue
                    if raw is None:
                        unresolved.append(ident);continue
                    target.parent.mkdir(parents=True,exist_ok=True)
                    if target.exists():
                        qdir=base/"quarantine"
                        qdir.mkdir(exist_ok=True)
                        if qdir.is_symlink():raise ValueError("Unsafe quarantine directory")
                        if not target.is_file() or target.stat().st_size>doc.MAX_BYTES:raise ValueError("Original requires manual inspection")
                        with tempfile.NamedTemporaryFile(dir=qdir,prefix=r["blob"]+"-",delete=False) as q:
                            q.write(target.read_bytes());q.flush();os.fsync(q.fileno())
                        quarantine.append(Path(q.name).name)
                    tmp=None
                    try:
                        with tempfile.NamedTemporaryFile(dir=target.parent,suffix=".tmp",delete=False) as out:
                            tmp=Path(out.name);out.write(raw);out.flush();os.fsync(out.fileno())
                        os.replace(tmp,target)
                    finally:
                        if tmp is not None:tmp.unlink(missing_ok=True)
                    doc.event(db,ident,"Оригинал восстановлен по SHA-256 из "+archive.name,r["node_id"])
                    repaired.append(ident)
                except (OSError,ValueError):
                    unresolved.append(ident)
        return {"repaired":repaired,"unresolved":unresolved,"quarantine":quarantine,"archives_checked":len(archives)}
    finally:LOCK.release()
