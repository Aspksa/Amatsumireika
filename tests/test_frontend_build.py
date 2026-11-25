import tempfile
import unittest
from pathlib import Path
from frontend_build import current,seal

class FrontendBuildTest(unittest.TestCase):
    def test_stale_source_and_output(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            (root/"src").mkdir()
            (root/"dist").mkdir()
            for name in ("package.json","tsconfig.json"):
                (root/name).write_text("{}")
            src=root/"src"/"app.ts"
            out=root/"dist"/"app.js"
            src.write_text("old")
            out.write_text("old")
            self.assertFalse(current(root))
            seal(root)
            self.assertTrue(current(root))
            src.write_text("new")
            self.assertFalse(current(root))
            out.write_text("new")
            seal(root)
            self.assertTrue(current(root))
            out.write_text("corrupt")
            self.assertFalse(current(root))
