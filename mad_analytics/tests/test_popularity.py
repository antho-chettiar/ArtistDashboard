"""Test artist popularity using Instagram data from the sheet scrape."""
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
    if val is None:
        return ""
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
            artists.append({"name": row["Artist names"].strip(), "username": ig})
    return artists


def scrape_instagram_data(artists):
    from apify_client import ApifyClient
    client = ApifyClient(API_TOKEN)
    usernames = [a["username"] for a in artists]

    print(f"\nScraping {len(usernames)} profiles...")
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

    results = []
    for artist in artists:
        uname = artist["username"].lower()
        pdata = profile_lookup.get(uname, {})
        user_posts = posts_by_user.get(uname, [])

        followers = int(pdata.get("followersCount") or pdata.get("followers") or 0)
        full_name = pdata.get("fullName") or pdata.get("name") or ""

        likes_list, comments_list = [], []
        for post in user_posts[:20]:
            likes_list.append(int(post.get("likesCount") or post.get("likes") or 0))
            comments_list.append(int(post.get("commentsCount") or post.get("comments") or 0))

        avg_likes = round(sum(likes_list) / len(likes_list), 1) if likes_list else 0.0
        avg_comments = round(sum(comments_list) / len(comments_list), 1) if comments_list else 0.0
        engagement_rate = round((avg_likes + avg_comments) / followers * 100, 4) if followers > 0 else 0.0

        results.append({
            "name": artist["name"],
            "username": uname,
            "followers": followers,
            "full_name": safe(full_name, 30),
            "avg_likes": avg_likes,
            "avg_comments": avg_comments,
            "engagement_rate": engagement_rate,
        })

    return results


def compute_popularity_scores(results):
    """
    Instagram-based popularity score (0-100):
      - 60% Follower Score: log-normalized follower count
      - 40% Engagement Score: log-normalized engagement rate
    """
    if not results:
        return results

    max_followers = max(r["followers"] for r in results) or 1
    max_er = max(r["engagement_rate"] for r in results) or 0.01

    for r in results:
        # Follower score (log scale): ln(1 + followers) / ln(1 + max_followers) * 100
        follower_score = min(100, math.log(1 + r["followers"]) / math.log(1 + max_followers) * 100)

        # Engagement score (log scale): ln(1 + er) / ln(1 + max_er) * 100
        er_score = 0.0
        if r["engagement_rate"] > 0 and max_er > 0:
            er_score = min(100, math.log(1 + r["engagement_rate"]) / math.log(1 + max_er) * 100)

        r["follower_score"] = round(follower_score, 2)
        r["engagement_score"] = round(er_score, 2)
        r["popularity_score"] = round(follower_score * 0.6 + er_score * 0.4, 2)

    return results


if __name__ == "__main__":
    print("=" * 120)
    print("Artist Popularity Test (Instagram-based)")
    print("=" * 120)
    print(f"Token: {API_TOKEN[:12]}...{API_TOKEN[-4:]}")
    print()

    artists = fetch_artists_from_sheet()
    print(f"Artists from sheet: {len(artists)}")
    for a in artists:
        print(f"  {a['name']:25s} -> @{a['username']}")

    raw = scrape_instagram_data(artists)
    results = compute_popularity_scores(raw)

    print(f"\n{'='*120}")
    print(f"{'Rank':<5} {'Artist':<22} {'Username':<22} {'Followers':>12} {'Avg Likes':>10} {'ER%':>8} {'Foll Score':>10} {'Eng Score':>10} {'Popularity':>10}")
    print(f"{'-'*5} {'-'*22} {'-'*22} {'-'*12} {'-'*10} {'-'*8} {'-'*10} {'-'*10} {'-'*10}")
    for i, r in enumerate(sorted(results, key=lambda x: x["popularity_score"], reverse=True), 1):
        print(
            f"{i:<5} {r['name']:<22} @{r['username']:<20} {r['followers']:>12,} "
            f"{r['avg_likes']:>10,.0f} {r['engagement_rate']:>7.3f}% "
            f"{r['follower_score']:>9.2f}  {r['engagement_score']:>9.2f}  {r['popularity_score']:>9.2f}"
        )

    print(f"\n{'='*120}")
    print(f"Score formula: Popularity = FollowerScore x 0.6 + EngagementScore x 0.4")
    print(f"FollowerScore = ln(1+f) / ln(1+max_f) x 100 (log scale)")
    print(f"EngagementScore = ln(1+ER) / ln(1+max_ER) x 100 (log scale)")
    print(f"{'='*120}")
