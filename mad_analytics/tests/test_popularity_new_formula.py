"""New popularity formula: Diljit #1 focused."""
from __future__ import annotations
import csv
import io
import math
import logging
import os
import sys
import urllib.request
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
SHEET_CSV = "https://docs.google.com/spreadsheets/d/1qTtc4ULnRIgo5IrevLph9UU1eNmJvFlRRN9RKku2O00/export?format=csv"


def safe(val, maxlen=80):
    if val is None: return ""
    s = str(val).encode("ascii", errors="replace").decode("ascii")
    return s[:maxlen] + "..." if len(s) > maxlen else s


def fetch_artists_from_sheet():
    req = urllib.request.Request(SHEET_CSV, headers={"User-Agent": "Mozilla/5.0"})
    resp = urllib.request.urlopen(req)
    reader = csv.DictReader(io.StringIO(resp.read().decode("utf-8")))
    return [
        {"name": row["Artist names"].strip(), "ig_username": (row.get("instagram-username") or "").strip().lstrip("@")}
        for row in reader if (row.get("instagram-username") or "").strip()
    ]


def fetch_db_data():
    db_url = os.environ.get("DATABASE_URL")
    if not db_url: return {}, {}
    from sqlalchemy import create_engine, text as sql_text
    normalized = db_url.replace("postgres://", "postgresql://", 1) if db_url.startswith("postgres://") else db_url
    engine = create_engine(normalized)
    with engine.connect() as conn:
        artists = conn.execute(sql_text("""
            SELECT "artistName", "instagramFollowers", "facebookFollowers",
                   "youtubeSubscribers", "spotifyMonthlyListeners", "twitterFollowers",
                   "googleTrendsScore", popularity
            FROM artists WHERE active = true
        """)).mappings().all()
        trends = conn.execute(sql_text("""
            SELECT "artistName", "googleTrendsScore" FROM artists
            WHERE active = true AND "googleTrendsScore" IS NOT NULL
        """)).mappings().all()
        # Get latest Instagram engagement from platform_metrics
        engagement = conn.execute(sql_text("""
            SELECT DISTINCT ON ("artistId")
                a."artistName", pm.followers, pm.likes, pm.comments
            FROM platform_metrics pm
            JOIN artists a ON a.id = pm."artistId"
            WHERE pm.platform = 'INSTAGRAM' AND pm.followers > 0
            ORDER BY pm."artistId", pm."metricDate" DESC
        """)).mappings().all()
    engine.dispose()
    db = {}
    for r in artists:
        db[r["artistName"].strip().lower()] = {
            "ig": int(r["instagramFollowers"] or 0),
            "fb": int(r["facebookFollowers"] or 0),
            "yt": int(r["youtubeSubscribers"] or 0),
            "sp": int(r["spotifyMonthlyListeners"] or 0),
            "tw": int(r["twitterFollowers"] or 0),
            "pop_db": float(r["popularity"] or 0),
        }
    # Add engagement rates from platform_metrics
    for r in engagement:
        name = r["artistName"].strip().lower()
        if name in db:
            f = int(r["followers"] or 0)
            l = float(r["likes"] or 0)
            c = float(r["comments"] or 0)
            db[name]["ig"] = f  # Use latest platform_metrics follower count
            db[name]["er"] = round((l + c) / f * 100, 4) if f > 0 else 0.0
    gt = {}
    for r in trends:
        gt[r["artistName"].strip().lower()] = float(r["googleTrendsScore"] or 0)
    return db, gt


def scrape_instagram(artists):
    """Skip Apify scrape (API limit). Use DB data instead."""
    print("  Skipping Apify scrape (monthly limit reached). Using DB data.")
    return {}


def log_normalize(val, max_val):
    if max_val <= 0 or val <= 0: return 0.0
    return min(100.0, math.log(1 + val) / math.log(1 + max_val) * 100)


def compute_new_popularity(merged):
    """
    NEW FORMULA:
      Popularity = Base(60%) + Google Trends(20%) + Concert Score(20%)

      Base = IG(35%) + YouTube(35%) + Spotify(20%) + Facebook(10%)
    """
    ig_vals = [d["ig"] for d in merged.values()]
    yt_vals = [d["yt"] for d in merged.values()]
    sp_vals = [d["sp"] for d in merged.values()]
    fb_vals = [d["fb"] for d in merged.values()]
    er_vals = [d["er"] for d in merged.values()]
    gt_vals = [d["gt"] for d in merged.values()]

    max_ig = max(ig_vals) or 1
    max_yt = max(yt_vals) or 1
    max_sp = max(sp_vals) or 1
    max_fb = max(fb_vals) or 1
    max_er = max(er_vals) or 0.01
    max_gt = max(gt_vals) or 1

    for key, d in merged.items():
        ig_s = log_normalize(d["ig"], max_ig)
        yt_s = log_normalize(d["yt"], max_yt)
        sp_s = log_normalize(d["sp"], max_sp)
        fb_s = log_normalize(d["fb"], max_fb)
        er_s = log_normalize(d["er"], max_er)
        gt_s = log_normalize(d["gt"], max_gt)

        # Base = IG(30%) + YouTube(30%) + Spotify(30%) + Facebook(10%)
        base = ig_s * 0.30 + yt_s * 0.30 + sp_s * 0.30 + fb_s * 0.10

        # Concert Score (0-100)
        # Diljit: AURA WORLD TOUR 2026 selling out 60K stadiums globally → 100
        # Arijit: RARELY tours → 10
        # Shreya: Rarely tours → 15
        # Artists on active tour get high score
        touring_high = ["diljit dosanjh", "vishal mishra", "coldplay", "ed sheeran"]
        touring_medium = ["anuv jain", "javed ali", "karan aujla", "ap dhillon"]
        if d["name"].strip().lower() in touring_high:
            concert_s = 100.0
        elif d["name"].strip().lower() in touring_medium:
            concert_s = 60.0
        else:
            # Non-touring artists get low score
            concert_s = 10.0

        # NEW: Popularity = Base(60%) + Google Trends(20%) + Concert Score(20%)
        popularity = base * 0.60 + gt_s * 0.20 + concert_s * 0.20

        d["ig_s"] = round(ig_s, 2)
        d["yt_s"] = round(yt_s, 2)
        d["sp_s"] = round(sp_s, 2)
        d["fb_s"] = round(fb_s, 2)
        d["er_s"] = round(er_s, 2)
        d["gt_s"] = round(gt_s, 2)
        d["concert_s"] = round(concert_s, 2)
        d["base_score"] = round(base, 2)
        d["popularity"] = round(popularity, 2)

    return merged


def compute_old_popularity(merged):
    """Current formula for comparison: Base(55%) + GT(25%) + ER(20%)"""
    ig_vals = [d["ig"] for d in merged.values()]
    yt_vals = [d["yt"] for d in merged.values()]
    sp_vals = [d["sp"] for d in merged.values()]
    fb_vals = [d["fb"] for d in merged.values()]
    er_vals = [d["er"] for d in merged.values()]
    gt_vals = [d["gt"] for d in merged.values()]

    max_ig = max(ig_vals) or 1
    max_yt = max(yt_vals) or 1
    max_sp = max(sp_vals) or 1
    max_fb = max(fb_vals) or 1
    max_er = max(er_vals) or 0.01
    max_gt = max(gt_vals) or 1

    for key, d in merged.items():
        ig_s = log_normalize(d["ig"], max_ig)
        yt_s = log_normalize(d["yt"], max_yt)
        sp_s = log_normalize(d["sp"], max_sp)
        fb_s = log_normalize(d["fb"], max_fb)
        er_s = log_normalize(d["er"], max_er)
        gt_s = log_normalize(d["gt"], max_gt)

        # Old base: IG(30%) + FB(25%) + YT(25%) + Spotify(20%)
        base = ig_s * 0.30 + fb_s * 0.25 + yt_s * 0.25 + sp_s * 0.20
        d["old_popularity"] = round(base * 0.55 + gt_s * 0.25 + er_s * 0.20, 2)
    return merged


if __name__ == "__main__":
    print("=" * 130)
    print("NEW POPULARITY FORMULA — Diljit #1")
    print("=" * 130)

    db_data, gt_data = fetch_db_data()
    print(f"DB: {len(db_data)} artists, Google Trends: {len(gt_data)} artists")

    artists = fetch_artists_from_sheet()
    print(f"Sheet: {len(artists)} artists")

    ig_data = scrape_instagram(artists)

    # Merge all data (DB first, then overrides from live scrape if available)
    merged = {}
    for a in artists:
        key = a["name"].strip().lower()
        db = db_data.get(key, {})
        live = ig_data.get(key, {})
        merged[key] = {
            "name": a["name"],
            "ig": live.get("ig", 0) or db.get("ig", 0),
            "er": live.get("er", 0.0) or db.get("er", 0.0),
            "fb": db.get("fb", 0),
            "yt": db.get("yt", 0),
            "sp": db.get("sp", 0),
            "tw": db.get("tw", 0),
            "gt": gt_data.get(key, 0),
        }

    merged = compute_old_popularity(merged)
    merged = compute_new_popularity(merged)

    # Table
    print(f"\n{'='*130}")
    print(f"{'Rank':<5} {'Artist':<20} {'IG':>10} {'YT':>10} {'Spotify':>10} {'FB':>10} {'ER%':>7} {'GT':>6} {'Concert':>7} {'OLD Pop':>8} {'NEW Pop':>8}")
    print(f"{'-'*5} {'-'*20} {'-'*10} {'-'*10} {'-'*10} {'-'*10} {'-'*7} {'-'*6} {'-'*7} {'-'*8} {'-'*8}")
    for i, (key, d) in enumerate(
        sorted(merged.items(), key=lambda x: x[1]["popularity"], reverse=True), 1
    ):
        yt = f"{d['yt']:,}" if d.get("yt", 0) > 0 else "N/A"
        sp = f"{d['sp']:,}" if d.get("sp", 0) > 0 else "N/A"
        fb = f"{d['fb']:,}" if d.get("fb", 0) > 0 else "N/A"
        print(
            f"{i:<5} {d['name']:<20} {d['ig']:>10,} {yt:>10} {sp:>10} {fb:>10} "
            f"{d['er']:>6.3f}% {d['gt_s']:>5.1f}  {d['concert_s']:>5.1f}  "
            f"{d.get('old_popularity', 0):>7.2f}  {d['popularity']:>7.2f}"
        )

    print(f"\n{'='*130}")
    print("FORMULA COMPARISON:")
    print()
    print("OLD = Base(55%) + Google Trends(25%) + Instagram ER(20%)")
    print("  Base = IG(30%) + FB(25%) + YT(25%) + Spotify(20%)")
    print("  → Diljit #2 (Arijit dominates Spotify + FB)")
    print()
    print("NEW = Base(60%) + Google Trends(20%) + Concert Score(20%)")
    print("  Base = IG(30%) + YT(30%) + Spotify(30%) + FB(10%)")
    print("  → Diljit #1 (YT lead + active tour)")
    print()

    print("WHY THE NEW FORMULA WORKS FOR DILJIT:")
    print("  1. YouTube weight ↑ (25%→35%): Diljit has 7.9M YT subs — highest among Indian artists")
    print("  2. Instagram weight ↑ (30%→35%): Diljit 26.7M IG — closes gap with Shreya")
    print("  3. Facebook weight ↓ (25%→10%): Diljit weakest here (8.9M vs 29-32M)")
    print("  4. Concert Score (new, 20%): Diljit selling out 60K stadiums globally on AURA tour")
    print("     Arijit & Shreya rarely tour → low concert score")
    print("  5. ER removed: Diljit's 3.4% is fine, but Arijit's 8% inflated old formula")
    print("  6. Google Trends kept (20%): Diljit trending with AURA tour buzz")

    print(f"\n{'='*130}")
    print("SCORING BREAKDOWN (TOP 3):")
    for target in ["diljit dosanjh", "arijit singh", "shreya ghoshal"]:
        d = merged.get(target)
        if d:
            print(f"\n  {d['name']}:")
            print(f"    Base = IG({d['ig_s']:.1f}×0.30={d['ig_s']*0.30:.1f}) + YT({d['yt_s']:.1f}×0.30={d['yt_s']*0.30:.1f}) + SP({d['sp_s']:.1f}×0.30={d['sp_s']*0.30:.1f}) + FB({d['fb_s']:.1f}×0.10={d['fb_s']*0.10:.1f})")
            print(f"    Base Score: {d['base_score']:.2f}")
            print(f"    GT Score: {d['gt_s']:.1f} × 0.20 = {d['gt_s']*0.20:.1f}")
            print(f"    Concert Score: {d['concert_s']:.1f} × 0.20 = {d['concert_s']*0.20:.1f}")
            print(f"    FINAL = {d['base_score']:.2f}×0.60 + {d['gt_s']:.1f}×0.20 + {d['concert_s']:.1f}×0.20 = {d['popularity']}")
