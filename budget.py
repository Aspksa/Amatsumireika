
"""Estimated local spend guard, not a provider-enforced account cap."""
from decimal import Decimal, InvalidOperation
from datetime import datetime, timezone
from contextlib import closing
import cloud_api

def init(db):
    db.execute("CREATE TABLE IF NOT EXISTS spend_limits(id INTEGER PRIMARY KEY CHECK(id=1),day INTEGER NOT NULL,month INTEGER NOT NULL)")
    db.execute("INSERT OR IGNORE INTO spend_limits VALUES(1,0,0)")
    db.execute("CREATE TABLE IF NOT EXISTS spend_rates(model TEXT PRIMARY KEY,input INTEGER NOT NULL,output INTEGER NOT NULL)")
    db.execute("CREATE TABLE IF NOT EXISTS spend_ledger(id TEXT PRIMARY KEY,model TEXT NOT NULL,day TEXT NOT NULL,reserved INTEGER NOT NULL,charged INTEGER NOT NULL,input_rate INTEGER NOT NULL,output_rate INTEGER NOT NULL)")
def money(v):
    if type(v) not in (int,float,str): raise ValueError("Invalid ruble amount")
    try: d=Decimal(str(v))
    except InvalidOperation: raise ValueError("Invalid amount") from None
    if not d.is_finite() or not 0<=d<=1_000_000: raise ValueError("Invalid amount")
    return int(d*1_000_000)
def totals(db):
    day=datetime.now(timezone.utc).date().isoformat()
    a,b=db.execute("SELECT COALESCE(SUM(CASE WHEN day=? THEN charged ELSE 0 END),0),COALESCE(SUM(charged),0) FROM spend_ledger WHERE substr(day,1,7)=?",(day,day[:7])).fetchone()
    return a,b,day
def state(path):
    with closing(cloud_api.connect(path)) as db, db:
        init(db)
        day,month=db.execute("SELECT day,month FROM spend_limits WHERE id=1").fetchone()
        a,b,_=totals(db)
        return {"day":day/1e6,"month":month/1e6,"day_used":a/1e6,"month_used":b/1e6,"rates":[{"model":r[0],"input":r[1]/1e6,"output":r[2]/1e6} for r in db.execute("SELECT model,input,output FROM spend_rates ORDER BY model")]}
def save(path,data):
    day,month=money(data.get("day")),money(data.get("month"))
    model=data.get("model")
    with closing(cloud_api.connect(path)) as db, db:
        init(db)
        if model:
            import json
            if model not in json.loads(db.execute("SELECT models FROM cloud_config WHERE id=1").fetchone()[0]): raise ValueError("Model not in catalog")
            a,b=money(data.get("input")),money(data.get("output"))
            if a==0 and b==0: raise ValueError("Enter verified nonzero rates")
            db.execute("INSERT INTO spend_rates VALUES(?,?,?) ON CONFLICT(model) DO UPDATE SET input=excluded.input,output=excluded.output",(model,a,b))
        db.execute("UPDATE spend_limits SET day=?,month=? WHERE id=1",(day,month))
    return state(path)
def reserve(db,ident,model,nin,nout):
    init(db)
    day,month=db.execute("SELECT day,month FROM spend_limits WHERE id=1").fetchone()
    rates=db.execute("SELECT input,output FROM spend_rates WHERE model=?",(model,)).fetchone()
    if not rates or day<=0 or month<=0: raise ValueError("Set positive ruble limits and verified model rates first")
    a,b,date=totals(db)
    estimate=(nin*rates[0]+nout*rates[1]+999999)//1000000
    if a+estimate>day or b+estimate>month: raise ValueError("Estimated budget exceeded")
    db.execute("INSERT INTO spend_ledger VALUES(?,?,?,?,?,?,?)",(ident,model,date,estimate,estimate,*rates))
def settle(db,ident,nin,nout):
    init(db)
    if nin is None or nout is None: return
    row=db.execute("SELECT input_rate,output_rate FROM spend_ledger WHERE id=?",(ident,)).fetchone()
    if row:
        db.execute("UPDATE spend_ledger SET charged=? WHERE id=?",((nin*row[0]+nout*row[1]+999999)//1000000,ident))
