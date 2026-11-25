"""Validate the local frontend against the exact current source tree."""
from hashlib import sha256
from pathlib import Path
import argparse
import json

ROOT = Path(__file__).resolve().parent

def digest(root=ROOT):
    h=sha256()
    files=[root/"package.json",root/"tsconfig.json",*sorted((root/"src").rglob("*.ts"))]
    for p in files:
        h.update(p.relative_to(root).as_posix().encode()+b"\0")
        h.update(p.read_bytes())
        h.update(b"\0")
    return h.hexdigest()

def signature(root=ROOT):
    return {"source":digest(root),"output":sha256((root/"dist"/"app.js").read_bytes()).hexdigest()}

def current(root=ROOT):
    try:
        stamp=json.loads((root/"dist"/".build.json").read_text(encoding="utf-8"))
        return stamp==signature(root)
    except (OSError,ValueError):
        return False

def seal(root=ROOT):
    path=root/"dist"/".build.json"
    temp=path.with_suffix(".tmp")
    temp.write_text(json.dumps(signature(root)),encoding="utf-8")
    temp.replace(path)

if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--seal",action="store_true")
    args=parser.parse_args()
    if args.seal:
        seal()
    else:
        raise SystemExit(0 if current() else 1)
