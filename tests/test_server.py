import tempfile
import unittest
from pathlib import Path
import sqlite3
from contextlib import closing
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
    def test_folder_and_migration(self):
        a=server.add_node("Файл","Документы","Работа/Отчёты")
        self.assertEqual(server.snapshot()["nodes"][0]["folder"],"Работа/Отчёты")
        with self.assertRaises(ValueError):
            server.add_node("X","Документы","../bad")
        server.initialize()
        self.assertEqual(server.snapshot()["nodes"][0]["id"],a)

    def test_legacy_schema(self):
        with closing(sqlite3.connect(server.DB)) as db, db:
            db.execute("DROP TABLE edges")
            db.execute("DROP TABLE nodes")
            db.execute("CREATE TABLE nodes(id INTEGER PRIMARY KEY,title TEXT NOT NULL,category TEXT NOT NULL)")
            db.execute("INSERT INTO nodes VALUES(1,'old','Знания')")
        server.initialize()
        self.assertEqual(server.snapshot()["nodes"][0]["folder"],"")

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
