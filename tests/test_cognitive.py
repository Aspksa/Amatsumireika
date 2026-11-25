
import tempfile
import unittest
from pathlib import Path
from contextlib import closing
from unittest.mock import patch
import server
import cognitive

class CognitiveTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.path=Path(self.temp.name)/"test.db"
        self.patch=patch.object(server,"DB",self.path);self.patch.start()
        server.initialize()
    def tearDown(self):
        self.patch.stop();self.temp.cleanup()
    def test_review_dedup_secret_and_conflict(self):
        server.send_chat("факт: автомобиль = Subaru")
        server.send_chat("факт: автомобиль = Subaru")
        server.send_chat("запомни: пароль = fakepassword")
        cognitive.cycle(self.path,True)
        v=cognitive.dashboard(self.path)
        self.assertEqual(len(v["candidates"]),1)
        cognitive.review(self.path,{"id":v["candidates"][0]["id"],"action":"approve"})
        self.assertEqual(len(server.snapshot()["nodes"]),1)
        server.send_chat("факт: автомобиль = Toyota")
        cognitive.cycle(self.path,True)
        c=cognitive.dashboard(self.path)["candidates"][0]
        self.assertTrue(c["conflict"])
        with self.assertRaises(ValueError): cognitive.review(self.path,{"id":c["id"],"action":"approve"})
        cognitive.review(self.path,{"id":c["id"],"action":"approve","confirm_conflict":True})
        self.assertEqual(len(server.snapshot()["nodes"]),2)
    def test_local_worker_pause_and_recall(self):
        a=server.add_node("Ремонт автомобиля","Знания")
        b=server.add_node("Ремонт автомобиля","Знания")
        cognitive.cycle(self.path,True)
        v=cognitive.dashboard(self.path)
        self.assertEqual(v["counts"]["fact"],2)
        self.assertTrue(any(r["kind"]=="duplicate" for r in v["relations"]))
        self.assertEqual(cognitive.lookup(self.path,"ремонт автомобиля",True)["results"][0]["score"],.667)
        cognitive.relation(self.path,{"source":a,"target":b,"kind":"cause","action":"approve"})
        self.assertEqual(len(server.snapshot()["edges"]),1)
        cognitive.configure(self.path,{"enabled":False,"style":"Деловой"})
        self.assertTrue(cognitive.cycle(self.path)["paused"])
        self.assertIn("Деловой",cognitive.system_profile(self.path,"как сделать"))
        self.assertEqual(cognitive.plan("исправь баг")["intent"],"repair")
        self.assertFalse(cognitive.plan("исправь баг")["executed"])
