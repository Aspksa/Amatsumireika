import os
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
import sqlite3
import cloud_api

class CloudTest(unittest.TestCase):
    def test_manual_catalog_and_statistics(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/"db.sqlite"
            key="test-secret-not-real"
            try:
                with patch.object(cloud_api,"fetch_models",return_value=(["model-a"],"connected")) as fetch:
                    self.assertFalse(cloud_api.state(path)["key_present"])
                    v=cloud_api.save(path,{"api_key":key})
                    self.assertTrue(v["key_present"])
                    self.assertNotIn(key,str(v))
                    fetch.assert_not_called()
                    v=cloud_api.refresh(path)
                    fetch.assert_called_once_with(key)
                    self.assertEqual(v["requests"],1)
                    self.assertEqual(v["successes"],1)
                    self.assertEqual(v["input_tokens"],0)
                    self.assertFalse(v["generation_enabled"])
                    self.assertEqual(cloud_api.save(path,{"model":"model-a"})["model"],"model-a")
                    with self.assertRaises(ValueError):
                        cloud_api.save(path,{"model":"unknown"})
                    fetch.return_value=(None,"network_error")
                    v=cloud_api.refresh(path)
                    self.assertEqual(v["failures"],1)
                    self.assertEqual(v["model"],"model-a")
                self.assertNotIn(key.encode(),path.read_bytes())
                if os.name=="nt":
                    self.assertEqual(cloud_api.state(path)["storage"],"windows_dpapi")
            finally:
                cloud_api.SESSION.pop(str(path),None)
    def test_no_redirect_and_no_request_without_key(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/"db.sqlite"
            with patch.object(cloud_api,"fetch_models") as fetch:
                with self.assertRaises(ValueError):
                    cloud_api.refresh(path)
                fetch.assert_not_called()
            self.assertIsNone(cloud_api.NoRedirect().redirect_request(None,None,302,None,None,"https://example.com"))
