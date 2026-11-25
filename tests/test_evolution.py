
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from contextlib import closing
import server
import evolution
import cognitive
import gateway

class EvolutionTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.path=Path(self.tmp.name)/"db"
        self.patch=patch.object(server,"DB",self.path);self.patch.start()
        server.initialize()
    def tearDown(self):
        self.patch.stop();self.tmp.cleanup()
    def test_retrieval_history_and_digest(self):
        a=server.add_node("Автомобиль = Subaru","Знания")
        b=server.add_node("Автомобиль = Toyota","Знания")
        c=server.add_node("Диагностика мотора","Навыки")
        server.add_edge(a,c)
        cognitive.cycle(self.path,True)
        self.assertEqual(len(evolution.report(self.path)["conflicts"]),1)
        evolution.fact_state(self.path,{"id":a,"state":"current"})
        with self.assertRaises(ValueError):evolution.fact_state(self.path,{"id":b,"state":"current"})
        evolution.fact_state(self.path,{"id":a,"state":"historical"})
        evolution.fact_state(self.path,{"id":b,"state":"current"})
        self.assertEqual(len(evolution.report(self.path)["conflicts"]),0)
        result=evolution.explore(self.path,{"query":"Subaru"})
        self.assertEqual(result["seeds"][0]["id"],a)
        self.assertEqual(result["experience"][0]["id"],c)
        self.assertEqual(result["seeds"][0]["state"],"historical")
        self.assertEqual(evolution.compress(self.path,{"ids":[a,b]})["source_ids"],[a,b])
        self.assertEqual(len(server.snapshot()["nodes"]),3)
        evolution.review_freshness(self.path,{"id":b,"days":30})
        self.assertEqual(len(evolution.report(self.path)["versions"]),3)
    def test_page_and_cached_semantic(self):
        a=server.add_node("Машина","Знания")
        b=server.add_node("Автомобиль","Знания")
        self.assertEqual(evolution.semantic_candidates(self.path,{"id":a})["pairs"],[])
        with closing(gateway.db_open(self.path)) as db,db:
            gateway.cache_vector(db,evolution.MODEL,"Машина",[1,0])
            gateway.cache_vector(db,evolution.MODEL,"Автомобиль",[1,0])
        self.assertEqual(evolution.semantic_candidates(self.path,{"id":a})["pairs"][0]["id"],b)
        page=evolution.page(self.path,0,1)
        self.assertEqual(page["next"],a)
        self.assertEqual(evolution.page(self.path,a,1)["nodes"][0]["id"],b)
