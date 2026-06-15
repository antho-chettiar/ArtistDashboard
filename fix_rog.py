"""Compute and store rogDaily for all platform_metrics from consecutive pairs."""
import os, sys
from pathlib import Path
from datetime import datetime

# Load DATABASE_URL from backend/.env
env_path = Path(__file__).parent / "backend" / ".env"
if env_path.exists():
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and not os.environ.get(key):
                    os.environ[key] = value

db_url = os.environ.get("DATABASE_URL")
if not db_url:
    print("FATAL: DATABASE_URL not found")
    sys.exit(1)

normalized = db_url.replace("postgres://", "postgresql://", 1) if db_url.startswith("postgres://") else db_url

from sqlalchemy import create_engine, text as sql_text

engine = create_engine(normalized)

# Fetch all platform_metrics ordered by artistId, platform, metricDate
with engine.connect() as conn:
    rows = conn.execute(sql_text("""
        SELECT id, "artistId", platform, followers, "metricDate"
        FROM platform_metrics
        ORDER BY "artistId", platform, "metricDate" ASC
    """)).mappings().all()

print(f"Fetched {len(rows)} platform_metric rows")

# Build consecutive pairs per (artistId, platform)
pairs = []
for i in range(1, len(rows)):
    curr = rows[i]
    prev = rows[i - 1]
    if curr["artistId"] == prev["artistId"] and curr["platform"] == prev["platform"]:
        days_diff = (curr["metricDate"] - prev["metricDate"]).days
        if 1 <= days_diff <= 45:
            prev_followers = float(prev["followers"]) if prev["followers"] else 0
            curr_followers = float(curr["followers"]) if curr["followers"] else 0
            if prev_followers > 0:
                rog_daily = ((curr_followers - prev_followers) / prev_followers) * 100 / days_diff
                pairs.append((curr["id"], round(rog_daily, 4)))

print(f"Found {len(pairs)} pairs with valid rogDaily")

# Update in batches
BATCH_SIZE = 100
updated = 0
for i in range(0, len(pairs), BATCH_SIZE):
    batch = pairs[i:i + BATCH_SIZE]
    with engine.begin() as conn:
        for metric_id, rog_val in batch:
            conn.execute(
                sql_text('UPDATE platform_metrics SET "rogDaily" = :rog WHERE id = :id'),
                {"rog": rog_val, "id": metric_id}
            )
    updated += len(batch)
    print(f"  Updated {updated}/{len(pairs)} rows...")

engine.dispose()
print(f"\nDone! Updated {updated} rows with rogDaily values.")
