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

    def test_calendar_manifest(self):
        from unittest.mock import patch
        record={"year":2027,"source":"https://www.consultant.ru/document/cons_doc_LAW_544706/","decree":"1187","reviewed":True,"rest":["02-22","05-03","05-10","06-14","11-05","12-31"],"short":["02-20","04-30","06-11","11-03"],"work":[],"totals":{"work":247,"rest":118,"short":4,"h40":1972}}
        result=server.save_calendar_manifest({"schema":1,"calendars":[record]})
        self.assertEqual(result["calendars"][0]["year"],2027)
        for bad in ({**record,"source":"https://evil.example/x"},{**record,"reviewed":False},{**record,"rest":["02-30"]},{**record,"totals":{"work":0}},{**record,"short":["02-22"]}):
            with self.assertRaises(ValueError):
                server.save_calendar_manifest({"schema":1,"calendars":[bad]})
        with patch.object(server,"urlopen",side_effect=OSError("offline")):
            self.assertEqual(len(server.refresh_calendars()["calendars"]),1)
        server.initialize()
        self.assertEqual(len(server.get_calendars()["calendars"]),1)
        bundled=server.load_bundled_calendars()
        self.assertEqual([r["year"] for r in bundled["calendars"]],[2026,2027])
        import json
        from io import BytesIO
        class FeedResponse(BytesIO):
            def geturl(self):
                return server.CALENDAR_FEED
        raw=(server.ROOT / "calendar" / "production-calendar.json").read_bytes()
        with patch.object(server,"urlopen",return_value=FeedResponse(raw)):
            self.assertEqual(len(server.refresh_calendars()["calendars"]),2)
        with patch.object(server,"urlopen",return_value=FeedResponse(b'{"schema":2}')):
            self.assertIn("не принято",server.refresh_calendars()["status"])
        self.assertEqual(len(server.get_calendars()["calendars"]),2)

    def test_work_ledger_and_timeline(self):
        import io
        import zipfile
        from xml.etree import ElementTree
        from datetime import datetime, timezone, timedelta
        server.load_bundled_calendars()
        profiles=server.save_profile({"name":"=Test <1>","schedule":"5/2","anchor":"2026-01-01","hours":8})
        pid=profiles[0]["id"]
        report=server.save_work_day({"profile_id":pid,"day":"2027-02-20","actual":9,"planned":None,"status":"normal"})
        row=next(r for r in report["rows"] if r["day"]=="2027-02-20")
        self.assertEqual((row["planned"],row["actual"],row["difference"]),(7,9,2))
        self.assertIsNone(row["override"])
        self.assertEqual(next(r for r in report["rows"] if r["day"]=="2027-02-22")["planned"],0)
        for schedule in ("2/2","6/1","shift"):
            server.save_profile({"name":schedule,"schedule":schedule,"anchor":"2027-02-01","hours":12})
        report=server.work_report("2027-02")
        self.assertEqual(len(report["rows"]),112)
        self.assertEqual(next(r for r in report["rows"] if r["name"]=="shift")["planned"],None)
        with self.assertRaises(ValueError):
            server.save_work_day({"profile_id":pid,"day":"2027-02-30","actual":8})
        with zipfile.ZipFile(io.BytesIO(server.report_xlsx("2027-02"))) as z:
            root=ElementTree.fromstring(z.read("xl/worksheets/sheet1.xml"))
            self.assertFalse(any(el.tag.endswith("}f") for el in root.iter()))
            self.assertIn("=Test &lt;1&gt;",z.read("xl/worksheets/sheet1.xml").decode())
        server.add_node("Knowledge","Знания")
        server.send_chat("private")
        now=datetime.now(timezone.utc)
        result=server.timeline_window((now-timedelta(minutes=1)).isoformat(),(now+timedelta(minutes=1)).isoformat())
        self.assertEqual(result["counts"]["nodes"],1)
        self.assertEqual(result["counts"]["chats"],1)
        self.assertNotIn("private",str(result))
        server.save_time_snapshot({"day":"2027-02-20","mode":"spiral"})
        server.initialize()
        self.assertEqual(server.get_time_snapshots()[0]["nodes"],1)
        self.assertEqual(len(server.get_profiles()),4)

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
