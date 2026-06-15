"""Check what data exists for Taylor Swift and Drake."""
import sys; sys.path.insert(0, '.')
from mad_analytics.utils.db import _get_db_url
from sqlalchemy import create_engine, text

engine = create_engine(_get_db_url())

with engine.connect() as conn:
    # Get artist IDs
    rows = conn.execute(text("SELECT id, name FROM artists WHERE name LIKE '%Taylor%' OR name LIKE '%Drake%'"))
    for r in rows:
        print(f"ID: {r.id}, Name: {r.name}")

    # Get their platform metrics
    rows2 = conn.execute(text("""
        SELECT artist_id, platform, metric_name, metric_value, recorded_at
        FROM platform_metrics
        WHERE artist_id IN (SELECT id FROM artists WHERE name LIKE '%Taylor%' OR name LIKE '%Drake%')
        ORDER BY artist_id, platform, recorded_at DESC
    """))
    for r in rows2:
        print(f"  {r.platform:<10} {r.metric_name:<30} {str(r.metric_value):<20} {r.recorded_at}")
