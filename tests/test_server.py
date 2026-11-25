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

    def test_visual_settings_and_events(self):
        self.assertEqual(server.get_settings(),{})
        saved=server.save_settings({"palette":"Океан","speed":1.2,"showLabels":False})
        server.initialize()
        self.assertEqual(server.get_settings(),saved)
        with self.assertRaises(ValueError):
            server.save_settings({"speed":float("nan")})
        with self.assertRaises(ValueError):
            server.save_settings({"showLabels":"yes"})
        a=server.add_node("A","Знания")
        b=server.add_node("B","Опыт")
        server.add_edge(a,b)
        server.add_edge(a,b)
        self.assertEqual([e["kind"] for e in server.get_events()],["edge","node","node","settings"])

    def test_created_at_and_scale(self):
        a=server.add_node("Новая","Знания","Корень/Подпапка")
        self.assertIsNotNone(server.snapshot()["nodes"][0]["created_at"])
        with closing(server.connect()) as db, db:
            for total in (1000,10000,50000,100000):
                existing=db.execute("SELECT COUNT(*) FROM nodes").fetchone()[0]
                db.executemany("INSERT INTO nodes(title,category,folder) VALUES(?,?,?)",
                    ((f"Record {i}","Знания",f"Group/{i%250}") for i in range(existing,total)))
                db.commit()
                snap=server.snapshot()
                self.assertEqual(len(snap["nodes"]),total)
                self.assertEqual(len({n["id"] for n in snap["nodes"]}),total)
                self.assertGreaterEqual(len({n["folder"] for n in snap["nodes"]}),250)
        self.assertEqual(server.snapshot()["nodes"][0]["id"],a)

    def test_local_chat(self):
        self.assertEqual(server.get_chat()["messages"],[])
        server.add_node("Test","Знания")
        result=server.send_chat("/статус")
        self.assertFalse(result["model_connected"])
        self.assertEqual([m["role"] for m in result["messages"]],["user","system"])
        self.assertIn("Записей: 1",result["messages"][1]["content"])
        server.send_chat("Привет")
        server.initialize()
        history=server.get_chat()["messages"]
        self.assertEqual(len(history),4)
        self.assertIn("необходимо подключить",history[-1]["content"])
        for value in (None," ","x"*3001):
            with self.assertRaises(ValueError):
                server.send_chat(value)
        self.assertEqual(len(server.get_chat()["messages"]),4)

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
