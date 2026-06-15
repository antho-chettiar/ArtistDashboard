"""Check what engagement fields are available in Apify responses."""
from __future__ import annotations
import json
import logging
import os
import sys
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

API_TOKEN = os.environ.get("APIFY_API_TOKEN")

from mad_analytics.scrapers.instagram import scrape_profiles_apify, scrape_posts_apify

# 1. Check profile-level latestPosts field
print("=== Profile latestPosts structure ===")
items = scrape_profiles_apify(["diljitdosanjh"], API_TOKEN)
if items:
    lp = items[0].get("latestPosts", [])
    print(f"  Profile has {len(lp)} latestPosts entries")
    if lp:
        print(f"  First entry fields ({len(lp[0])} keys):")
        for k, v in sorted(lp[0].items()):
            val = str(v)[:80]
            print(f"    [{k}] = {val}")

# 2. Check if any post fields contain share/save/send related data
print("\n=== Post-level engagement fields ===")
posts = scrape_posts_apify(["diljitdosanjh"], API_TOKEN, posts_per_user=5)
if posts:
    all_keys = set()
    for p in posts:
        all_keys.update(p.keys())
    
    # Filter for engagement-related fields
    engagement_keywords = ["like", "comment", "share", "save", "send", "view", "play", "bookmark", "engage"]
    relevant = sorted(k for k in all_keys if any(x in k.lower() for x in engagement_keywords))
    print(f"  Engagement-related fields found in post data:")
    for k in relevant:
        vals = [str(p.get(k, ""))[:40] for p in posts[:3]]
        print(f"    [{k}] = {vals}")
    
    other = sorted(k for k in all_keys if k not in relevant)
    print(f"\n  Other fields ({len(other)}):")
    for k in other:
        vals = [str(p.get(k, ""))[:40] for p in posts[:3]]
        print(f"    [{k}] = {vals}")

print("\nDone.")
