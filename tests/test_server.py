import tempfile
import unittest
from pathlib import Path
import sqlite3
import server

class AtlasTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.old=server.DB
        server.DB=Path(self.temp.name)/"atlas.db"
        server.initialize()
    def tearDown(self):
        server.DB=self.old
        self.temp.cleanup()
    def test_persistence_and_edges(self):
        a=server.add_node("Первая","Знания")
        b=server.add_node("Вторая","Опыт")
        server.add_edge(b,a)
        server.add_edge(a,b)
        server.initialize()
        self.assertEqual(len(server.snapshot()["nodes"]),2)
        self.assertEqual(server.snapshot()["edges"],[{"source":a,"target":b}])
    def test_invalid(self):
        with self.assertRaises(ValueError):
            server.add_node("","Знания")
        with self.assertRaises(ValueError):
            server.add_node("X","fake")
        with self.assertRaises(ValueError):
            server.add_edge(1,1)
        with self.assertRaises(sqlite3.IntegrityError):
            server.add_edge(1,2)

if __name__=="__main__":
    unittest.main()
