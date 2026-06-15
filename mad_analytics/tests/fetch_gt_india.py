"""Fetch Google Trends with India geo + 'singer' suffix for 1 month.
Then re-run the multi-scenario test.
"""
import sys, os, logging
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")

env_path = Path(__file__).parent.parent.parent / "backend" / ".env"
if env_path.exists():
    with open(env_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and not os.environ.get(key):
                    os.environ[key] = value

from mad_analytics.trends.google_trends import fetch_trends_scores
from sqlalchemy import create_engine, text as sql_text

db_url = os.environ.get("DATABASE_URL")
normalized = db_url.replace("postgres://", "postgresql://", 1) if db_url.startswith("postgres://") else db_url
engine = create_engine(normalized)

# Get artist names
with engine.connect() as conn:
    rows = conn.execute(
        sql_text('SELECT id, "artistName" FROM artists WHERE active = true')
    ).mappings().all()
artists = [dict(r) for r in rows]
artist_names = [a["artistName"] for a in artists]
name_to_id = {a["artistName"]: a["id"] for a in artists}

print(f"Fetching GT: geo=IN, suffix=' singer', timeframe=today 1-m for {len(artist_names)} artists")
scores = fetch_trends_scores(artist_names, geo="IN", timeframe="today 1-m", suffix=" singer")

if not scores or all(v <= 0 for v in scores.values()):
    print("All scores zero — aborting DB save")
    engine.dispose()
    sys.exit(1)

with engine.begin() as conn:
    try:
        conn.execute(sql_text("""
            ALTER TABLE artists ADD COLUMN IF NOT EXISTS "googleTrendsScore" DECIMAL(5,2)
        """))
    except Exception:
        pass
    for name, score in scores.items():
        artist_id = name_to_id.get(name)
        if artist_id:
            conn.execute(
                sql_text('UPDATE artists SET "googleTrendsScore" = :score WHERE id = :id'),
                {"score": round(score, 2), "id": artist_id},
            )

engine.dispose()
print(f"Stored {len(scores)} scores in DB.")
print(f"\nResult ({len(scores)} artists):")
for name, score in sorted(scores.items(), key=lambda x: -x[1]):
    print(f"  {name:<25} {score:.1f}")
