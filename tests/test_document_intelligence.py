import base64
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from contextlib import closing
import server
import documents as doc
import document_workspace as work
import document_intelligence as intel

class DocumentIntelligenceTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.path=Path(self.tmp.name)/"db"
        self.p=patch.object(server,"DB",self.path);self.p.start()
        server.initialize()
    def tearDown(self):
        self.p.stop();self.tmp.cleanup()
    def put(self,name,body,defer=False):
        return doc.upload(self.path,{"name":name,"data":base64.b64encode(body.encode()).decode(),"defer":defer})
    def test_exact_fragments_and_ranking(self):
        body="# Глава 1\n\n🦊 Проверка двигателя\n\n"+"длинный текст "*120+"\n\nуникальный фильтр двигателя"
        a=self.put("A.txt",body)
        b=self.put("B.txt","другой фильтр")
        with closing(doc.connect(self.path)) as db:
            rows=db.execute("SELECT * FROM doc_fragments WHERE document_id=? ORDER BY seq",(a["id"],)).fetchall()
            self.assertTrue(all(body[x["start_offset"]:x["end_offset"]]==x["body"] and len(x["body"])<=800 for x in rows))
        result=work.excerpts(self.path,"уникальный фильтр двигателя")
        self.assertEqual(result["sources"][0]["id"],a["id"])
        hit=result["sources"][0]
        self.assertEqual(body[hit["start_offset"]:hit["end_offset"]],hit["excerpt"])
        self.assertEqual(hit["section"],"# Глава 1")
        self.assertEqual(result["pending"],0)
        doc.action(self.path,{"action":"trash","id":a["id"]})
        self.assertNotIn(a["id"],[x["id"] for x in work.excerpts(self.path,"фильтр")["sources"]])
        doc.action(self.path,{"action":"restore","id":a["id"]})
        self.assertEqual(work.excerpts(self.path,"уникальный")["sources"][0]["id"],a["id"])
    def test_worker_reindex_and_legacy_fallback(self):
        a=self.put("A.txt","факт: машина = Subaru\nдвигатель фильтр",True)
        self.assertTrue(work.step(self.path))
        self.assertTrue(work.excerpts(self.path,"фильтр")["sources"])
        work.mutate(self.path,{"action":"reindex","id":a["id"]})
        self.assertFalse(work.excerpts(self.path,"фильтр")["sources"])
        self.assertTrue(work.step(self.path))
        with closing(doc.connect(self.path)) as db,db:
            db.execute("DELETE FROM doc_fragments WHERE document_id=?",(a["id"],))
            db.execute("DELETE FROM doc_fragment_state WHERE document_id=?",(a["id"],))
        result=work.excerpts(self.path,"фильтр")
        self.assertEqual(result["pending"],1)
        self.assertEqual(result["sources"][0]["id"],a["id"])
        self.assertTrue(work.step(self.path))
        self.assertEqual(work.excerpts(self.path,"фильтр")["pending"],0)
    def test_evidence_versions_and_classification(self):
        a=self.put("A.txt","факт: машина = Subaru\nдвигатель топливо ремонт\nстарый текст")
        b=self.put("B.txt","факт: машина = Toyota\nдвигатель топливо ремонт\nновый текст")
        doc.action(self.path,{"action":"candidates","id":a["id"]})
        details=work.details(self.path,a["id"])
        self.assertTrue(any(x["document"]==b["id"] and x["kind"]=="возможное противоречие" and "Toyota" in x["quote"] for x in details["evidence"]))
        self.assertTrue(any(x["id"]==b["id"] and x["shared"] for x in details["suggestions"]))
        p=details["provenance"][0]
        self.assertTrue(p["current"])
        self.assertEqual(p["quote"],"факт: машина = Subaru")
        self.assertEqual(p["method"],"captured")
        work.mutate(self.path,{"action":"version","id":b["id"],"parent":a["id"]})
        result=intel.compare(self.path,b["id"])
        self.assertTrue(result["confirmed_version"])
        self.assertEqual(result["claim_changes"][0]["before"],["subaru"])
        self.assertEqual(result["claim_changes"][0]["after"],["toyota"])
        self.assertTrue(result["changes"])
        with self.assertRaises(ValueError):intel.approve_classification(self.path,{"id":a["id"],"category":"Автотранспорт"})
        approved=intel.approve_classification(self.path,{"id":a["id"],"category":"Автотранспорт","confirm":True})
        self.assertTrue(approved["approved"]["current"])
        self.assertEqual(doc.preview(self.path,a["id"])["folder"],"")
        with closing(doc.connect(self.path)) as db,db:
            db.execute("UPDATE documents SET content=? WHERE id=?",("новое содержание",a["id"]))
        updated=work.details(self.path,a["id"])
        self.assertFalse(updated["provenance"][0]["current"])
        self.assertFalse(updated["classification"]["approved"]["current"])
        self.assertEqual(updated["fragment_pending"],1)
    def test_legacy_source_backfill_only_matches(self):
        a=self.put("A.txt","факт: машина = Subaru")
        doc.action(self.path,{"action":"candidates","id":a["id"]})
        with closing(doc.connect(self.path)) as db,db:
            db.execute("DELETE FROM doc_source_quotes")
            db.execute("DELETE FROM doc_fragments")
            db.execute("DELETE FROM doc_fragment_state")
        self.assertTrue(work.step(self.path))
        quotes=work.details(self.path,a["id"])["provenance"]
        self.assertEqual(len(quotes),1)
        self.assertEqual(quotes[0]["method"],"reconstructed_match")
        self.assertTrue(quotes[0]["current"])
