
import tempfile
import unittest
from pathlib import Path
from contextlib import closing
from unittest.mock import patch
import sqlite3
import server
import cognitive
import gateway
import cloud_api

class IntegrityTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.path=Path(self.tmp.name)/"test.db"
        self.patcher=patch.object(server,"DB",self.path);self.patcher.start()
        server.initialize()
    def tearDown(self):
        cloud_api.SESSION.pop(str(self.path),None)
        self.patcher.stop();self.tmp.cleanup()
    def test_oldest_record_and_revision_100k(self):
        initial=server.snapshot()["revision"]
        node=server.add_node("уникальная старая запись","Знания")
        with closing(server.connect()) as db,db:
            db.executemany("INSERT INTO nodes(title,category,folder) VALUES(?,?,?)",((f"Record {i}","Знания","Тест") for i in range(99999)))
        self.assertEqual(gateway.search(self.path,"уникальная старая запись")[0]["id"],node)
        self.assertEqual(cognitive.lookup(self.path,"уникальная старая запись")["results"][0]["id"],node)
        self.assertGreater(cognitive.dashboard(self.path,True)["revision"],initial)
        self.assertEqual(cognitive.dashboard(self.path,True)["health"]["nodes"],100000)
    def test_backup_before_migration(self):
        server.add_node("Сохранить меня","Знания")
        server.send_chat("Сохранить разговор")
        with closing(server.connect()) as db,db: db.execute("PRAGMA user_version=4")
        server.initialize()
        backup=self.path.with_name(self.path.name+".before-v5.bak")
        self.assertTrue(backup.exists())
        with closing(sqlite3.connect(backup)) as db:
            self.assertEqual(db.execute("SELECT title FROM nodes").fetchone()[0],"Сохранить меня")
            self.assertEqual(db.execute("SELECT COUNT(*) FROM chat_messages").fetchone()[0],2)
    def test_explicit_memory_consent_and_no_automatic_replay(self):
        node=server.add_node("Локальная запись","Знания")
        cloud_api.SESSION[str(self.path)]="fake-test-key"
        with closing(gateway.db_open(self.path)) as db,db:
            db.execute("UPDATE cloud_config SET model='openai/gpt-5.5',models='[\"openai/gpt-5.5\"]' WHERE id=1")
        gateway.budget.save(self.path,{"day":10,"month":100,"model":"openai/gpt-5.5","input":1,"output":1})
        class Inline:
            def __init__(self,target,args,daemon):self.target=target;self.args=args
            def start(self):self.target(*self.args)
        sent=[]
        def stream(key,payload):
            sent.append(payload)
            return iter([{"choices":[{"delta":{"content":"Ответ"}}],"usage":{"prompt_tokens":10,"completion_tokens":2}},None])
        data={"id":"a"*32,"content":"Вопрос","confirm":True,"memory":[{"id":node,"title":"Локальная запись","category":"Знания"}]}
        with patch.object(gateway,"Thread",Inline),patch.object(gateway,"stream_response",side_effect=stream):
            with self.assertRaises(ValueError):gateway.submit(self.path,data)
            self.assertEqual(sent,[])
            self.assertEqual(gateway.submit(self.path,{**data,"memory_confirm":True})["status"],"done")
            self.assertIn("Локальная запись",str(sent[0]))
            self.assertEqual(gateway.submit(self.path,{"id":"b"*32,"content":"Другой вопрос","confirm":True})["status"],"done")
            self.assertNotIn("Локальная запись",str(sent[1]))
