"""Scrape Instagram for all artists from the Google Sheet."""
from __future__ import annotations
import csv
import io
import logging
import os
import sys
import urllib.request
from dataclasses import dataclass, field
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


def safe(val: str, maxlen: int = 80) -> str:
    if val is None:
        return ""
    s = str(val)
    s = s.encode("ascii", errors="replace").decode("ascii")
    if len(s) > maxlen:
        s = s[:maxlen] + "..."
    return s


def fetch_artists_from_sheet() -> list[dict]:
    """Fetch artist list from Google Sheet CSV export."""
    req = urllib.request.Request(SHEET_CSV, headers={"User-Agent": "Mozilla/5.0"})
    resp = urllib.request.urlopen(req)
    content = resp.read().decode("utf-8")
    reader = csv.DictReader(io.StringIO(content))
    artists = []
    for row in reader:
        ig = (row.get("instagram-username") or "").strip().lstrip("@")
        if ig:
            artists.append({
                "artist_name": row["Artist names"].strip(),
                "instagram_username": ig,
            })
    return artists


def scrape_instagram_for_artists(artists: list[dict], api_token: str) -> list[dict]:
    """Scrape profiles and posts for all artists, return results."""
    from apify_client import ApifyClient

    client = ApifyClient(api_token)
    usernames = [a["instagram_username"] for a in artists]

    # Step 1: Profiles
    print(f"\nScraping {len(usernames)} profiles...")
    profile_run = client.actor("apify/instagram-profile-scraper").call(run_input={"usernames": usernames})
    profile_did = profile_run.default_dataset_id if hasattr(profile_run, 'default_dataset_id') else profile_run["defaultDatasetId"]
    profile_items = list(client.dataset(profile_did).iterate_items())
    print(f"  Got {len(profile_items)} profiles")

    profile_lookup = {}
    for item in profile_items:
        uname = item.get("username", "").lower()
        if uname:
            profile_lookup[uname] = item

    # Step 2: Posts
    print(f"Scraping posts (10 per artist)...")
    post_run = client.actor("apify/instagram-post-scraper").call(run_input={
        "username": usernames,
        "resultsLimit": 20,
    })
    post_did = post_run.default_dataset_id if hasattr(post_run, 'default_dataset_id') else post_run["defaultDatasetId"]
    post_items = list(client.dataset(post_did).iterate_items())
    print(f"  Got {len(post_items)} posts total")

    posts_by_user = {}
    for post in post_items:
        owner = (post.get("ownerUsername") or post.get("username") or "").lower()
        if owner:
            posts_by_user.setdefault(owner, []).append(post)

    # Step 3: Build results
    results = []
    for artist in artists:
        uname = artist["instagram_username"].lower()
        pdata = profile_lookup.get(uname, {})
        user_posts = posts_by_user.get(uname, [])

        followers = int(pdata.get("followersCount") or pdata.get("followers") or 0)
        following = int(pdata.get("followsCount") or pdata.get("following") or 0)
        posts_count = int(pdata.get("postsCount") or pdata.get("posts") or 0)
        full_name = pdata.get("fullName") or pdata.get("name") or ""
        bio = pdata.get("biography") or pdata.get("bio") or ""
        verified = bool(pdata.get("verified") or pdata.get("isVerified"))

        likes_list = []
        comments_list = []
        latest_posts = []

        for post in user_posts[:20]:
            likes = int(post.get("likesCount") or post.get("likes") or 0)
            comments = int(post.get("commentsCount") or post.get("comments") or 0)
            likes_list.append(likes)
            comments_list.append(comments)
            latest_posts.append({
                "likes": likes,
                "comments": comments,
                "caption": safe(post.get("caption", "") or "", 80),
                "timestamp": post.get("timestamp") or post.get("date") or "",
                "url": post.get("url") or post.get("postUrl") or "",
            })

        avg_likes = round(sum(likes_list) / len(likes_list), 1) if likes_list else 0.0
        avg_comments = round(sum(comments_list) / len(comments_list), 1) if comments_list else 0.0
        engagement_rate = round((avg_likes + avg_comments) / followers * 100, 4) if followers > 0 else 0.0

        results.append({
            "artist": artist["artist_name"],
            "username": uname,
            "followers": followers,
            "following": following,
            "posts": posts_count,
            "full_name": full_name,
            "bio": safe(bio, 60),
            "verified": verified,
            "avg_likes": avg_likes,
            "avg_comments": avg_comments,
            "engagement_rate": engagement_rate,
            "posts_scraped": len(likes_list),
            "success": bool(pdata),
        })

    return results


if __name__ == "__main__":
    print("=" * 110)
    print("Instagram Scraper — Artists from Google Sheet")
    print("=" * 110)
    print(f"API Token: {API_TOKEN[:12]}...{API_TOKEN[-4:]}")
    print()

    artists = fetch_artists_from_sheet()
    print(f"Found {len(artists)} artists in sheet:")
    for a in artists:
        print(f"  {a['artist_name']:25s} -> @{a['instagram_username']}")

    if not artists:
        print("No artists found. Exiting.")
        sys.exit(1)

    results = scrape_instagram_for_artists(artists, API_TOKEN)

    successful = [r for r in results if r["success"]]
    failed = [r for r in results if not r["success"]]

    print(f"\n{'='*110}")
    print(f"{'Artist':<25} {'Username':<22} {'Followers':>12} {'Posts':>6} {'Avg Likes':>10} {'Avg Cmts':>10} {'ER%':>8}")
    print(f"{'-'*25} {'-'*22} {'-'*12} {'-'*6} {'-'*10} {'-'*10} {'-'*8}")
    for r in sorted(successful, key=lambda x: x["followers"], reverse=True):
        print(
            f"{r['artist']:<25} @{r['username']:<20} {r['followers']:>12,} {r['posts']:>6,} "
            f"{r['avg_likes']:>10,.0f} {r['avg_comments']:>10,.0f} {r['engagement_rate']:>7.3f}%"
        )

    if failed:
        print(f"\nFailed ({len(failed)}):")
        for r in failed:
            print(f"  @{r['username']} ({r['artist']}): no profile data")

    print(f"\n{'='*110}")
    print(f"Successful: {len(successful)}/{len(results)}  |  Failed: {len(failed)}")
    print(f"{'='*110}")
