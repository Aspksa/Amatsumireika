
import base64
import os
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

    def test_verified_repair_and_quarantine(self):
        a=self.put("A.txt","abcd")
        b=self.put("B.txt","efgh")
        document_backup.backup(self.path)
        c=self.put("C.txt","no backup")
        with closing(doc.connect(self.path)) as db:
            ap=doc.path_for(self.path,doc.get(db,a["id"])["blob"])
            bp=doc.path_for(self.path,doc.get(db,b["id"])["blob"])
            cp=doc.path_for(self.path,doc.get(db,c["id"])["blob"])
        ap.write_bytes(b"zzzz");bp.unlink();cp.unlink()
        result=document_backup.repair(self.path)
        self.assertEqual(result["repaired"],[a["id"],b["id"]])
        self.assertEqual(result["unresolved"],[c["id"]])
        self.assertEqual(ap.read_bytes(),b"abcd")
        self.assertEqual(bp.read_bytes(),b"efgh")
        self.assertEqual((self.path.parent/"backups"/"quarantine"/result["quarantine"][0]).read_bytes(),b"zzzz")
        self.assertEqual(doc.health(self.path,True)["corrupt"],[])
        self.assertEqual(document_backup.repair(self.path)["repaired"],[])

    def test_cluster_and_source_history(self):
        a=self.put("A.txt","двигатель ремонт масло фильтр")
        b=self.put("B.txt","двигатель ремонт масло фильтр")
        c=self.put("C.txt","бухгалтерия отчёт налоги")
        nodes={x["id"]:x for x in work.graph(self.path)["nodes"]}
        self.assertEqual(nodes[a["id"]]["cluster"],nodes[b["id"]]["cluster"])
        self.assertNotEqual(nodes[a["id"]]["cluster"],nodes[c["id"]]["cluster"])
        self.assertEqual(nodes[b["id"]]["cluster_method"],"keywords")
        self.assertEqual(work.graph(self.path)["edges"],[])
        d=self.put("D.txt","факт: машина = Toyota")
        doc.action(self.path,{"action":"candidates","id":d["id"]})
        with closing(doc.connect(self.path)) as db,db:
            db.execute("DELETE FROM document_sources WHERE document_id=?",(d["id"],))
        result=work.rebuild_sources(self.path)
        self.assertEqual(result["added"],1)
        history=work.history(self.path,d["id"])
        self.assertTrue(history["events"])
        self.assertEqual(len(history["sources"]),1)
        self.assertFalse(history["historical_complete"])
        self.assertEqual(work.rebuild_sources(self.path)["added"],0)

    def test_ocr_transaction_and_index(self):
        import document_ocr
        raw=b"%PDF-1.4\n"
        a=doc.upload(self.path,{"name":"scan.pdf","data":base64.b64encode(raw).decode()})
        with patch.object(document_ocr,"recognize",return_value={"text":"уникальный двигатель","pages":1,"total":3}):
            result=document_ocr.run(self.path,a["id"])
        self.assertTrue(result["indexed"])
        self.assertEqual(result["total"],3)
        self.assertIn("уникальный",doc.preview(self.path,a["id"])["text"])
        self.assertEqual(len(work.excerpts(self.path,"уникальный")["sources"]),1)
        self.assertEqual(work.quality(self.path)["index_mismatch"],[])
        self.assertEqual(doc.binary(self.path,a["id"])[1],raw)
        with self.assertRaises(ValueError):document_ocr.run(self.path,a["id"])

    def test_rebuild_confirmed_source_edge(self):
        a=self.put("A.txt","факт: автомобиль = Subaru")
        doc.action(self.path,{"action":"candidates","id":a["id"]})
        with closing(doc.connect(self.path)) as db:
            candidate=db.execute("SELECT id FROM cog_candidates").fetchone()[0]
        cognitive.review(self.path,{"id":candidate,"action":"approve"})
        with closing(doc.connect(self.path)) as db,db:
            db.execute("DELETE FROM edges WHERE source=? OR target=?",(a["node_id"],a["node_id"]))
        self.assertEqual(work.rebuild_sources(self.path)["links"],1)
        self.assertEqual(work.quality(self.path)["source_edges_missing"],[])
        self.assertEqual(work.rebuild_sources(self.path)["links"],0)

    @unittest.skipUnless(os.name=="nt","Windows native PDF renderer")
    def test_native_windows_thumbnail(self):
        import document_ocr
        # Valid single-page PDF; no external renderer or fixtures.
        stream=b"BT /F1 24 Tf 30 100 Td (TEST DOCUMENT) Tj ET"
        objects=[
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 180] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
            b"<< /Length "+str(len(stream)).encode()+b" >>\nstream\n"+stream+b"\nendstream",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
        ]
        raw=b"%PDF-1.4\n";offsets=[]
        for i,obj in enumerate(objects,1):
            offsets.append(len(raw));raw+=str(i).encode()+b" 0 obj\n"+obj+b"\nendobj\n"
        xref=len(raw)
        raw+=b"xref\n0 6\n0000000000 65535 f \n"
        for offset in offsets:raw+=("%010d 00000 n \n"%offset).encode()
        raw+=b"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n"+str(xref).encode()+b"\n%%EOF\n"
        a=doc.upload(self.path,{"name":"test.pdf","data":base64.b64encode(raw).decode()})
        img=document_ocr.pdf_thumbnail(self.path,a["id"])
        self.assertTrue(img.startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertEqual(doc.binary(self.path,a["id"])[1],raw)
