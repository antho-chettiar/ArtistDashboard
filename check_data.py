import sys; sys.path.insert(0, '.')
from mad_analytics.utils.db import get_connection_string
import sqlalchemy as sa
engine = sa.create_engine(get_connection_string())
with engine.connect() as conn:
    rows = conn.execute(sa.text("SELECT id, name FROM artists WHERE name LIKE '%Taylor%' OR name LIKE '%Drake%'"))
    for r in rows:
        print(f"ID: {r.id}, Name: {r.name}")
