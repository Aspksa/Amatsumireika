import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
from contextlib import closing
import cloud_api
import gateway
import server

class GatewayTest(unittest.TestCase):
    def test_stream_usage_and_dedup(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/"db"
            with patch.object(server,"DB",path):
                server.initialize()
            cloud_api.SESSION[str(path)]="fake-test-key"
            try:
                with closing(gateway.db_open(path)) as db, db:
                    db.execute("UPDATE cloud_config SET model='openai/gpt-5.5',models='[\"openai/gpt-5.5\"]' WHERE id=1")
                gateway.budget.save(path,{"day":10,"month":100,"model":"openai/gpt-5.5","input":1,"output":1})
                class Inline:
                    def __init__(self,target,args,daemon): self.target=target;self.args=args
                    def start(self): self.target(*self.args)
                chunks=[{"choices":[{"delta":{"content":"Hello "}}]},{"choices":[{"delta":{"content":"world"}}],"usage":{"prompt_tokens":12,"completion_tokens":2}},None]
                data={"id":"a"*32,"content":"hello","confirm":True}
                with patch.object(gateway,"Thread",Inline),patch.object(gateway,"stream_response",return_value=iter(chunks)) as stream:
                    with self.assertRaises(ValueError): gateway.submit(path,{**data,"confirm":False})
                    job=gateway.submit(path,data)
                    self.assertEqual(job["status"],"done")
                    self.assertEqual(job["answer"],"Hello world")
                    self.assertEqual(job["input_tokens"],12)
                    self.assertEqual(gateway.submit(path,data)["id"],data["id"])
                    self.assertEqual(gateway.submit(path,{**data,"id":"b"*32})["id"],data["id"])
                    stream.assert_called_once()
                self.assertEqual(cloud_api.state(path)["output_tokens"],2)
                self.assertEqual(gateway.history(path)["models"][0]["requests"],1)
            finally: cloud_api.SESSION.pop(str(path),None)
    def test_local_search_and_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/"db"
            with patch.object(server,"DB",path):
                server.initialize()
                server.add_node("Машина","Знания")
            self.assertEqual(gateway.search(path,"Машина")[0]["title"],"Машина")
            with closing(gateway.db_open(path)) as db, db:
                gateway.cache_vector(db,"test","Автомобиль",[1,0])
                gateway.cache_vector(db,"test","Машина",[1,0])
            self.assertEqual(gateway.search(path,"Автомобиль","test")[0]["title"],"Машина")
            gateway.recover(path)

    def test_budget_blocks_and_local_tools(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/"db"
            with patch.object(server,"DB",path):
                server.initialize()
                server.add_node("Машина","Знания")
            with closing(gateway.db_open(path)) as db, db:
                with self.assertRaises(ValueError): gateway.budget.reserve(db,"x","model",100,100)
            self.assertEqual(gateway.local_tool(path,"local_counts",{})["nodes"],1)
            self.assertEqual(gateway.local_tool(path,"local_search",{"query":"Машина"})[0]["title"],"Машина")
            with self.assertRaises(ValueError): gateway.local_tool(path,"delete",{})
            self.assertIn("reasoning",gateway.classify("deepseek-ai/DeepSeek-V4-Pro")["capabilities"])
