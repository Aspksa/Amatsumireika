
import base64
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from contextlib import closing
import server
import documents
import document_workspace as workspace

class WorkspaceTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.path=Path(self.tmp.name)/"db"
        self.patch=patch.object(server,"DB",self.path);self.patch.start()
        server.initialize()
    def tearDown(self):
        self.patch.stop();self.tmp.cleanup()
    def put(self,name,text,folder="",defer=False):
        return documents.upload(self.path,{"name":name,"folder":folder,"data":base64.b64encode(text.encode()).decode(),"defer":defer})
    def test_queue_recovery_and_search(self):
        a=self.put("А.txt","уникальный двигатель",defer=True)
        self.assertEqual(a["extract_status"],"queued")
        self.assertTrue(workspace.step(self.path))
        self.assertFalse(workspace.step(self.path))
        self.assertEqual(documents.preview(self.path,a["id"])["text"],"уникальный двигатель")
        self.assertEqual(workspace.excerpts(self.path,"двигатель")["sources"][0]["id"],a["id"])
        workspace.mutate(self.path,{"action":"reindex","id":a["id"]})
        self.assertTrue(workspace.step(self.path))
        self.assertEqual(workspace.analytics(self.path)["jobs"]["done"],1)
    def test_links_versions_evidence(self):
        a=self.put("A.txt","факт: автомобиль = Subaru\nдвигатель ремонт","Гараж/А")
        b=self.put("B.txt","факт: автомобиль = Toyota\nдвигатель ремонт","Гараж/Б")
        self.assertEqual(len(documents.list_docs(self.path,where="Гараж")["files"]),2)
        self.assertTrue(workspace.details(self.path,a["id"])["suggestions"])
        self.assertTrue(any(x["kind"]=="возможное противоречие" for x in workspace.details(self.path,a["id"])["evidence"]))
        workspace.mutate(self.path,{"action":"version","id":b["id"],"parent":a["id"]})
        with self.assertRaises(ValueError):workspace.mutate(self.path,{"action":"version","id":a["id"],"parent":b["id"]})
        g=workspace.graph(self.path)
        self.assertEqual(len(g["edges"]),1)
        self.assertEqual(len(g["versions"]),1)
        self.assertEqual(workspace.analytics(self.path)["isolated"],0)
        workspace.mutate(self.path,{"action":"batch","ids":[a["id"],b["id"]],"mode":"trash"})
        self.assertEqual(workspace.graph(self.path)["total"],0)
    def test_missing_blob_reports_failure(self):
        a=self.put("a.txt","test",defer=True)
        with closing(documents.connect(self.path)) as db:blob=documents.get(db,a["id"])["blob"]
        documents.path_for(self.path,blob).unlink()
        self.assertTrue(workspace.step(self.path))
        self.assertEqual(workspace.analytics(self.path)["jobs"]["failed"],1)
