"""Mimic the dashboard controller's getTopArtists logic to see the ranking."""
import json, os, math, sys
from pathlib import Path
from datetime import datetime, timedelta

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

def fetch_json(url):
    import urllib.request
    with urllib.request.urlopen(url) as r:
        return json.loads(r.read())

# Get artist names from backend
artists_data = fetch_json("http://localhost:3001/api/v1/artists")["data"]["artists"]
name_map = {a["id"]: a["artistName"] for a in artists_data}
trends_map = {a["id"]: float(a.get("googleTrendsScore") or 0) for a in artists_data}

# Get platform_metrics from last 90 days
ninety_days_ago = datetime.utcnow() - timedelta(days=90)
with engine.connect() as conn:
    metrics = conn.execute(sql_text("""
        SELECT "artistId", platform, followers, "rogDaily", "metricDate"
        FROM platform_metrics
        WHERE "metricDate" >= :cutoff
        ORDER BY "metricDate" DESC
    """), {"cutoff": ninety_days_ago}).mappings().all()
engine.dispose()

print(f"Found {len(metrics)} metrics in last 90 days")

# Deduplicate: keep only the latest metric per artist+platform
latest = {}
for m in metrics:
    key = f"{m['artistId']}:{m['platform']}"
    if key not in latest:
        latest[key] = m

latest_list = list(latest.values())
print(f"After dedup: {len(latest_list)} rows")

# Group by artist
artist_data = {}
for m in latest_list:
    aid = m["artistId"]
    if aid not in artist_data:
        artist_data[aid] = {"platforms": {}, "rogs": []}
    artist_data[aid]["platforms"][m["platform"]] = float(m["followers"] or 0)
    if m["rogDaily"] is not None:
        artist_data[aid]["rogs"].append(float(m["rogDaily"]))

# Platform weights (same as dashboard controller)
PLATFORM_WEIGHTS = {"INSTAGRAM": 0.35, "YOUTUBE": 0.35, "SPOTIFY": 0.20, "FACEBOOK": 0.10}

# Compute platform max per platform
platform_max = {}
for aid, adata in artist_data.items():
    for plat, flw in adata["platforms"].items():
        p = plat.upper()
        platform_max[p] = max(platform_max.get(p, 0), flw)

# Score each artist
results = []
for aid, adata in artist_data.items():
    # Base score
    base = 0.0
    for plat, weight in PLATFORM_WEIGHTS.items():
        flw = adata["platforms"].get(plat, 0)
        mx = platform_max.get(plat, 1)
        norm = (flw / mx) * 100 if mx > 0 else 0
        base += norm * weight
    base = min(100, max(0, base))

    # Trends
    trends = trends_map.get(aid, 0)

    # RoG score (same log scale as dashboard controller)
    rogs = adata["rogs"]
    avg_rog = sum(rogs) / len(rogs) if rogs else 0
    if avg_rog > 0:
        rog_score = min(100, round((math.log(1 + avg_rog * 40) / math.log(81)) * 100))
    else:
        rog_score = 0

    composite = round(base * 0.50 + trends * 0.25 + rog_score * 0.25)

    results.append({
        "name": name_map.get(aid, aid[:8]),
        "base": round(base, 1),
        "trends": trends,
        "rog": round(avg_rog, 4),
        "rog_score": rog_score,
        "composite": composite,
    })

results.sort(key=lambda r: r["composite"], reverse=True)

print(f"\n{'Rank':>4s} {'Composite':>9s}  {'Base':>5s}  {'Trends':>6s}  {'RoG':>7s}  {'Artist':30s}")
print("-" * 75)
for i, r in enumerate(results, 1):
    print(f"{i:4d} {r['composite']:9d}  {r['base']:5.1f}  {r['trends']:6.0f}  {r['rog_score']:7d}  {r['name']:30s}")

print("\n--- Detailed (avg_rog_raw) ---")
for i, r in enumerate(results, 1):
    print(f"{i:4d} {r['composite']:9d}  avg_rog={r['rog']:.4f}  rog_score={r['rog_score']}")
