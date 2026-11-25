
import tempfile
import unittest
from pathlib import Path
from contextlib import closing
from unittest.mock import patch
import server
import cognitive
import evolution
import memory_engine as memory

class Integrity61Test(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.path=Path(self.tmp.name)/"db"
        self.patcher=patch.object(server,"DB",self.path);self.patcher.start()
        server.initialize()
    def tearDown(self):
        self.patcher.stop();self.tmp.cleanup()
    def test_tiny_vectors(self):
        self.assertAlmostEqual(memory.cosine([1e-300,0],[1e-300,0]),1)
        self.assertEqual(memory.cosine([0,0],[1,0]),0)
    def test_two_current_before_indexing(self):
        a=server.add_node("Авто = A","Знания")
        b=server.add_node("Авто = B","Знания")
        evolution.fact_state(self.path,{"id":a,"state":"current"})
        with self.assertRaises(ValueError):evolution.fact_state(self.path,{"id":b,"state":"current"})
        evolution.fact_state(self.path,{"id":a,"state":"historical"})
        evolution.fact_state(self.path,{"id":b,"state":"current"})
        self.assertNotIn(a,[r["id"] for r in evolution.preview(self.path,"Авто")["seeds"]])
    def test_union_two_groups_and_preserve_links(self):
        with closing(server.connect()) as db,db:
            ids=[db.execute("INSERT INTO nodes(title,category,folder) VALUES('Одинаковая запись','Знания','')").lastrowid for _ in range(4)]
        a,b,c,d=ids
        skill=server.add_node("Уникальный метод","Навыки")
        server.add_edge(d,skill)
        cognitive.cycle(self.path,True)
        for x,y in [(a,b),(c,d),(b,d)]:
            cognitive.relation(self.path,{"source":x,"target":y,"kind":"duplicate","action":"approve"})
        with closing(evolution.connect(self.path)) as db:
            self.assertEqual([memory.canonical(db,i) for i in ids],[a]*4)
        result=evolution.explore(self.path,{"query":"Одинаковая запись"})
        self.assertEqual([r["id"] for r in result["seeds"]],[a])
        self.assertEqual([r["id"] for r in result["experience"]],[skill])
        self.assertTrue(evolution.quality(self.path)["ok"])
    def test_plan_and_summaries(self):
        a=server.add_node("Диагностика двигателя","Навыки")
        b=server.add_node("Диагностика автомобиля","Знания")
        server.add_edge(a,b)
        evolution.compress(self.path,{"ids":[a,b]})
        self.assertTrue(evolution.explore(self.path,{"query":"Диагностика"})["summaries"])
        self.assertIn("сохранённого опыта",server.send_chat("/план Диагностика")["messages"][-1]["content"])
    def test_v6_backup(self):
        with closing(server.connect()) as db,db:db.execute("PRAGMA user_version=5")
        server.initialize()
        self.assertTrue(self.path.with_name(self.path.name+".before-v6.bak").exists())
        with closing(server.connect()) as db:self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0],6)
