"""Check the latest popularity ranking with artist names."""
import json, urllib.request, os
from pathlib import Path

# Load env
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

# Fetch artist names from backend
with urllib.request.urlopen("http://localhost:3001/api/v1/artists") as resp:
    data = json.loads(resp.read())
id_to_name = {a["id"]: a["artistName"] for a in data["data"]["artists"]}

# Fetch saved popularity
with urllib.request.urlopen("http://localhost:8001/popularity/saved") as resp:
    saved = json.loads(resp.read())

print(f"{'Rank':>4s} {'Score':>6s}  {'Trends':>7s}  {'RoG':>7s}  {'Artist':30s}")
print("-" * 65)
for i, d in enumerate(sorted(saved, key=lambda x: x["popularity_score"], reverse=True), 1):
    pc = d.get("platform_contributions", {})
    trends_raw = pc.get("google_trends", 0) * 4
    rog_raw = pc.get("rog", 0) * 4
    name = id_to_name.get(d["artist_id"], "???")
    print(f"{i:4d} {d['popularity_score']:6.2f}  {trends_raw:7.1f}  {rog_raw:7.1f}  {name:30s}")

# Also check the artist popularity column (updated by scheduler job)
print("\n--- Artist popularity column (from scheduler update) ---")
with urllib.request.urlopen("http://localhost:3001/api/v1/artists") as resp:
    artists = json.loads(resp.read())["data"]["artists"]
artists.sort(key=lambda a: float(a.get("popularity", 0)), reverse=True)
for i, a in enumerate(artists, 1):
    print(f"{i:4d} {float(a.get('popularity',0)):6.2f}  {a['artistName']:30s}")
