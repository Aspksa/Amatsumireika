
import base64
import io
import tempfile
import unittest
import zipfile
from pathlib import Path
from contextlib import closing
from unittest.mock import patch
import server
import documents
import cognitive
import evolution
import memory_engine as memory

def encoded(raw):
    return base64.b64encode(raw).decode("ascii")
def office(name,xml):
    buf=io.BytesIO()
    with zipfile.ZipFile(buf,"w") as z:z.writestr(name,xml)
    return buf.getvalue()

class DocumentTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.path=Path(self.tmp.name)/"db"
        self.patcher=patch.object(server,"DB",self.path);self.patcher.start()
        server.initialize()
    def tearDown(self):
        self.patcher.stop();self.tmp.cleanup()
    def put(self,name,raw,folder=""):
        return documents.upload(self.path,{"name":name,"data":encoded(raw),"folder":folder})
    def test_storage_index_trash_restore(self):
        raw="факт: автомобиль = Subaru\nуникальная запчасть".encode()
        f=self.put("Отчёт.txt",raw,"Гараж/Отчёты")
        self.assertEqual(documents.binary(self.path,f["id"])[1],raw)
        self.assertTrue(self.put("Отчёт.txt",raw,"Гараж/Отчёты")["duplicate"])
        with closing(server.connect()) as db,db:memory.index_batch(db)
        with closing(server.connect()) as db:
            self.assertEqual(memory.search(db,"запчасть")[0]["id"],f["node_id"])
        self.assertEqual(documents.list_docs(self.path,"запчасть")["count"],1)
        self.assertIn("Отчёт.txt",server.send_chat("/документы запчасть")["messages"][-1]["content"])
        other=server.add_node("Гараж","Знания")
        documents.action(self.path,{"action":"link","id":f["id"],"node":other})
        self.assertEqual(len(server.snapshot()["edges"]),1)
        documents.action(self.path,{"action":"candidates","id":f["id"]})
        self.assertEqual(len(cognitive.dashboard(self.path)["candidates"]),1)
        documents.action(self.path,{"action":"trash","id":f["id"]})
        self.assertEqual(len(server.snapshot()["nodes"]),1)
        self.assertEqual(len(server.snapshot_window()["edges"]),0)
        self.assertEqual(documents.list_docs(self.path,trash=True)["files"][0]["id"],f["id"])
        with closing(server.connect()) as db:self.assertEqual(memory.search(db,"запчасть"),[])
        with self.assertRaises(ValueError):documents.binary(self.path,f["id"])
        documents.action(self.path,{"action":"restore","id":f["id"]})
        self.assertEqual(len(server.snapshot()["edges"]),1)
        self.assertEqual(documents.binary(self.path,f["id"])[1],raw)
    def test_office_formats_and_limits(self):
        word=office("word/document.xml",'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Договор</w:t></w:r></w:p></w:body></w:document>')
        f=self.put("договор.docx",word)
        self.assertIn("Договор",documents.preview(self.path,f["id"])["text"])
        excel=office("xl/worksheets/sheet1.xml",'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c t="inlineStr"><is><t>Топливо</t></is></c><c><v>123</v></c></row></sheetData></worksheet>')
        x=self.put("топливо.xlsx",excel)
        self.assertIn("Топливо\t123",documents.preview(self.path,x["id"])["text"])
        pdf=self.put("test.pdf",b"%PDF-1.4\n")
        self.assertEqual(pdf["extract_status"],"preview_only")
        with self.assertRaises(ValueError):self.put("../bad.txt",b"bad")
        with self.assertRaises(ValueError):self.put("bad.exe",b"bad")
        with self.assertRaises(ValueError):self.put("bad.pdf",b"bad")
        with self.assertRaises(ValueError):self.put("empty.txt",b"")
        self.assertEqual(documents.health(self.path)["missing"],[])
    def test_distinct_same_name_and_hash_check(self):
        a=self.put("same.txt",b"first")
        b=self.put("same.txt",b"second")
        self.assertNotEqual(a["node_id"],b["node_id"])
        cognitive.cycle(self.path,True)
        with self.assertRaises(ValueError):cognitive.relation(self.path,{"source":a["node_id"],"target":b["node_id"],"kind":"duplicate","action":"approve"})
        with closing(documents.connect(self.path)) as db:blob=documents.get(db,a["id"])["blob"]
        documents.path_for(self.path,blob).write_bytes(b"wrong")
        with self.assertRaises(ValueError):documents.binary(self.path,a["id"])
    def test_schema_backup(self):
        with closing(server.connect()) as db,db:db.execute("PRAGMA user_version=6")
        server.initialize()
        self.assertTrue(self.path.with_name(self.path.name+".before-v7.bak").exists())
