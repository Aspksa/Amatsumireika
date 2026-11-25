
import base64
import tempfile
import unittest
import zipfile
from pathlib import Path
from contextlib import closing
from unittest.mock import patch
import server
import documents as doc
import document_workspace as work
import document_backup
import cognitive
import memory_engine as memory

class ImperialIntegrityTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.path=Path(self.tmp.name)/"db"
        self.patch=patch.object(server,"DB",self.path);self.patch.start()
        server.initialize()
    def tearDown(self):
        self.patch.stop();self.tmp.cleanup()
    def put(self,name,text,folder=""):
        return doc.upload(self.path,{"name":name,"folder":folder,"data":base64.b64encode(text.encode()).decode()})
    def test_hash_and_backup(self):
        a=self.put("A.txt","abcd")
        v=document_backup.backup(self.path)
        with zipfile.ZipFile(self.path.parent/"backups"/v["name"]) as z:
            self.assertIn("database.sqlite",z.namelist())
            self.assertIn("manifest.json",z.namelist())
        with closing(doc.connect(self.path)) as db:blob=doc.get(db,a["id"])["blob"]
        doc.path_for(self.path,blob).write_bytes(b"zzzz")
        self.assertEqual(doc.health(self.path,True)["corrupt"],[a["id"]])
        with self.assertRaises(ValueError):self.put("A.txt","abcd")
        with self.assertRaises(ValueError):document_backup.backup(self.path)
    def test_reindex_and_filtered_graph(self):
        a=self.put("A.txt","двигатель уникальный","A")
        b=self.put("B.txt","ремонт двигателя","B")
        doc.action(self.path,{"action":"link","id":a["id"],"node":b["node_id"]})
        g=work.graph(self.path,where="A")
        self.assertEqual(g["total"],1)
        self.assertEqual(g["nodes"][0]["outside"],1)
        work.mutate(self.path,{"action":"reindex","id":a["id"]})
        self.assertEqual(work.excerpts(self.path,"уникальный")["sources"],[])
        with closing(doc.connect(self.path)) as db:blob=doc.get(db,a["id"])["blob"]
        doc.path_for(self.path,blob).unlink()
        work.step(self.path)
        self.assertEqual(work.excerpts(self.path,"уникальный")["sources"],[])
        self.assertEqual(work.quality(self.path)["index_mismatch"],[])
        doc.action(self.path,{"action":"trash","id":b["id"]})
        self.assertEqual(work.graph(self.path,trash=True)["total"],1)
        with self.assertRaises(ValueError):server.add_edge(a["node_id"],b["node_id"])
    def test_multiple_document_sources(self):
        a=self.put("A.txt","факт: автомобиль = Subaru")
        b=self.put("B.txt","факт: автомобиль = Subaru")
        for v in (a,b):doc.action(self.path,{"action":"candidates","id":v["id"]})
        with closing(doc.connect(self.path)) as db:
            candidate=db.execute("SELECT id FROM cog_candidates").fetchone()[0]
            self.assertEqual(db.execute("SELECT COUNT(*) FROM document_sources").fetchone()[0],2)
        cognitive.review(self.path,{"id":candidate,"action":"approve"})
        self.assertEqual(len(work.details(self.path,a["id"])["memories"]),1)
        self.assertEqual(len(work.details(self.path,b["id"])["memories"]),1)
        self.assertEqual(work.quality(self.path)["source_edges_missing"],[])
    def test_trashed_source_review(self):
        a=self.put("A.txt","факт: машина = Toyota")
        doc.action(self.path,{"action":"candidates","id":a["id"]})
        with closing(doc.connect(self.path)) as db:candidate=db.execute("SELECT id FROM cog_candidates").fetchone()[0]
        doc.action(self.path,{"action":"trash","id":a["id"]})
        with self.assertRaises(ValueError):cognitive.review(self.path,{"id":candidate,"action":"approve"})
