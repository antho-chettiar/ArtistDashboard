"""Multi-platform artist popularity using Instagram + DB data."""
from __future__ import annotations
import csv
import io
import math
import logging
import os
import sys
import urllib.request
from datetime import datetime
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
    artists = []
    for row in reader:
        ig = (row.get("instagram-username") or "").strip().lstrip("@")
        if ig:
            artists.append({"name": row["Artist names"].strip(), "ig_username": ig})
    return artists


def fetch_db_artist_data():
    """Fetch Instagram, Facebook, YouTube followers from DB."""
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        return {}

    from sqlalchemy import create_engine, text as sql_text
    normalized = db_url.replace("postgres://", "postgresql://", 1) if db_url.startswith("postgres://") else db_url
    engine = create_engine(normalized)

    with engine.connect() as conn:
        rows = conn.execute(sql_text("""
            SELECT "artistName",
                   "instagramFollowers",
                   "facebookFollowers",
                   "youtubeSubscribers",
                   "spotifyMonthlyListeners",
                   "twitterFollowers",
                   popularity
            FROM artists
            WHERE active = true
        """)).mappings().all()

    engine.dispose()
    result = {}
    for r in rows:
        name = r["artistName"].strip().lower()
        result[name] = {
            "instagramFollowers": int(r["instagramFollowers"] or 0),
            "facebookFollowers": int(r["facebookFollowers"] or 0),
            "youtubeSubscribers": int(r["youtubeSubscribers"] or 0),
            "spotifyMonthlyListeners": int(r["spotifyMonthlyListeners"] or 0),
            "twitterFollowers": int(r["twitterFollowers"] or 0),
            "popularity_db": float(r["popularity"] or 0),
        }
    return result


def scrape_instagram_data(artists):
    from apify_client import ApifyClient
    client = ApifyClient(API_TOKEN)
    usernames = [a["ig_username"] for a in artists]

    print(f"\nScraping {len(usernames)} Instagram profiles...")
    profile_run = client.actor("apify/instagram-profile-scraper").call(run_input={"usernames": usernames})
    profile_did = profile_run.default_dataset_id if hasattr(profile_run, 'default_dataset_id') else profile_run["defaultDatasetId"]
    profile_items = list(client.dataset(profile_did).iterate_items())

    profile_lookup = {}
    for item in profile_items:
        uname = item.get("username", "").lower()
        if uname:
            profile_lookup[uname] = item

    print(f"Scraping posts (20 per artist)...")
    post_run = client.actor("apify/instagram-post-scraper").call(run_input={
        "username": usernames, "resultsLimit": 20,
    })
    post_did = post_run.default_dataset_id if hasattr(post_run, 'default_dataset_id') else post_run["defaultDatasetId"]
    post_items = list(client.dataset(post_did).iterate_items())

    posts_by_user = {}
    for post in post_items:
        owner = (post.get("ownerUsername") or post.get("username") or "").lower()
        if owner:
            posts_by_user.setdefault(owner, []).append(post)

    results = {}
    for artist in artists:
        uname = artist["ig_username"].lower()
        pdata = profile_lookup.get(uname, {})
        user_posts = posts_by_user.get(uname, [])

        followers = int(pdata.get("followersCount") or pdata.get("followers") or 0)
        likes_list = [int(p.get("likesCount") or p.get("likes") or 0) for p in user_posts[:20]]
        comments_list = [int(p.get("commentsCount") or p.get("comments") or 0) for p in user_posts[:20]]

        avg_likes = round(sum(likes_list) / len(likes_list), 1) if likes_list else 0.0
        avg_comments = round(sum(comments_list) / len(comments_list), 1) if comments_list else 0.0
        er = round((avg_likes + avg_comments) / followers * 100, 4) if followers > 0 else 0.0

        results[artist["name"].strip().lower()] = {
            "name": artist["name"],
            "ig_followers": followers,
            "ig_engagement_rate": er,
        }

    return results


def compute_popularity(data):
    """
    Multi-platform popularity (0-100):
    60% Base (entropy-weighted platform followers):
        - Instagram followers (30% of base)
        - Facebook followers (25% of base)
        - YouTube subscribers (25% of base)
        - Spotify listeners (20% of base)
    25% Instagram Engagement Rate
    15% Twitter followers (bonus for social buzz)

    All normalized via log-scale.
    """
    if not data:
        return data

    # Gather all values for normalization
    all_ig = [d["ig_followers"] for d in data.values()]
    all_fb = [d.get("fb_followers", 0) for d in data.values()]
    all_yt = [d.get("yt_subscribers", 0) for d in data.values()]
    all_sp = [d.get("spotify_listeners", 0) for d in data.values()]
    all_tw = [d.get("tw_followers", 0) for d in data.values()]
    all_er = [d["ig_engagement_rate"] for d in data.values()]

    max_ig = max(all_ig) or 1
    max_fb = max(all_fb) or 1
    max_yt = max(all_yt) or 1
    max_sp = max(all_sp) or 1
    max_tw = max(all_tw) or 1
    max_er = max(all_er) or 0.01

    for key, d in data.items():
        ig_score = min(100, math.log(1 + d["ig_followers"]) / math.log(1 + max_ig) * 100) if d["ig_followers"] > 0 else 0
        fb_score = min(100, math.log(1 + d.get("fb_followers", 0)) / math.log(1 + max_fb) * 100) if d.get("fb_followers", 0) > 0 else 0
        yt_score = min(100, math.log(1 + d.get("yt_subscribers", 0)) / math.log(1 + max_yt) * 100) if d.get("yt_subscribers", 0) > 0 else 0
        sp_score = min(100, math.log(1 + d.get("spotify_listeners", 0)) / math.log(1 + max_sp) * 100) if d.get("spotify_listeners", 0) > 0 else 0
        tw_score = min(100, math.log(1 + d.get("tw_followers", 0)) / math.log(1 + max_tw) * 100) if d.get("tw_followers", 0) > 0 else 0
        er_score = min(100, math.log(1 + d["ig_engagement_rate"]) / math.log(1 + max_er) * 100) if d["ig_engagement_rate"] > 0 else 0

        # Base = entropy-weighted platform followers
        base_score = ig_score * 0.30 + fb_score * 0.25 + yt_score * 0.25 + sp_score * 0.20

        d["ig_score"] = round(ig_score, 2)
        d["fb_score"] = round(fb_score, 2)
        d["yt_score"] = round(yt_score, 2)
        d["sp_score"] = round(sp_score, 2)
        d["tw_score"] = round(tw_score, 2)
        d["er_score"] = round(er_score, 2)
        d["base_score"] = round(base_score, 2)

        # Final blended score
        d["popularity"] = round(base_score * 0.60 + er_score * 0.25 + tw_score * 0.15, 2)

    return data


if __name__ == "__main__":
    print("=" * 130)
    print("Multi-Platform Artist Popularity")
    print("=" * 130)

    db_data = fetch_db_artist_data()
    print(f"\nDB: Found {len(db_data)} active artists with platform data")

    artists = fetch_artists_from_sheet()
    print(f"Sheet: {len(artists)} artists")

    ig_data = scrape_instagram_data(artists)
    print(f"Instagram: {len(ig_data)} artists scraped")

    # Merge DB + Instagram data
    merged = {}
    for artist in artists:
        key = artist["name"].strip().lower()
        merged[key] = {
            "name": artist["name"],
            "ig_followers": ig_data.get(key, {}).get("ig_followers", 0),
            "ig_engagement_rate": ig_data.get(key, {}).get("ig_engagement_rate", 0.0),
            "fb_followers": db_data.get(key, {}).get("facebookFollowers", 0),
            "yt_subscribers": db_data.get(key, {}).get("youtubeSubscribers", 0),
            "spotify_listeners": db_data.get(key, {}).get("spotifyMonthlyListeners", 0),
            "tw_followers": db_data.get(key, {}).get("twitterFollowers", 0),
            "popularity_db": db_data.get(key, {}).get("popularity_db", 0),
        }

    results = compute_popularity(merged)

    print(f"\n{'='*130}")
    header = f"{'Rank':<5} {'Artist':<20} {'IG Foll':>10} {'FB Foll':>10} {'YT Subs':>10} {'Spotify':>10} {'IG ER%':>7} {'Base':>7} {'Popularity':>10}"
    print(header)
    print("-" * 130)
    for i, (key, d) in enumerate(sorted(results.items(), key=lambda x: x[1]["popularity"], reverse=True), 1):
        fb = f"{d['fb_followers']:,}" if d.get("fb_followers", 0) > 0 else "N/A"
        yt = f"{d['yt_subscribers']:,}" if d.get("yt_subscribers", 0) > 0 else "N/A"
        sp = f"{d['spotify_listeners']:,}" if d.get("spotify_listeners", 0) > 0 else "N/A"
        print(
            f"{i:<5} {d['name']:<20} {d['ig_followers']:>10,} {fb:>10} {yt:>10} {sp:>10} "
            f"{d['ig_engagement_rate']:>6.3f}% {d['base_score']:>6.2f}  {d['popularity']:>8.2f}"
        )

    print(f"\n{'='*130}")
    print("POPULARITY FORMULA:")
    print("  60% Base Score = IG_Followers(30%) + FB_Followers(25%) + YT_Subs(25%) + Spotify(20%)")
    print("  25% Instagram Engagement Rate (log-normalized)")
    print("  15% Twitter Followers (social buzz)")
    print("  All scores log-normalized to 0-100")
    print()
    print("OTHER PARAMETERS THAT CAN BE USED:")
    print("  - Spotify Monthly Listeners (already included)")
    print("  - YouTube Subscribers (already included)")
    print("  - Twitter Followers (already included)")
    print("  - Apple Music Listeners (premium streaming audience)")
    print("  - Google Trends Score (real-time search interest)")
    print("  - Concert Ticket Sales Velocity (how fast tickets sell)")
    print("  - Wikipedia Page Views (public interest indicator)")
    print("  - Shazam Counts (music discovery signal)")
    print("  - TikTok Followers (emerging platform reach)")
    print("  - Spotify Playlist Reach (editorial playlist inclusion)")
    print("  - News/Media Mentions (press coverage volume)")
    print("  - Rate of Growth (30-day follower growth across platforms)")
    print("  - City-Level Demand Score (market-specific popularity)")
    print("  - Billboard/Chart Rankings (industry recognition)")
    print(f"{'='*130}")
