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
