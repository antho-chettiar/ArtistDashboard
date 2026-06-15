"""Test Instagram scraper with Apify API."""
from __future__ import annotations
import json
import logging
import os
import sys
from pathlib import Path

# Force UTF-8 for output
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

# Load env
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
if not API_TOKEN:
    print("ERROR: APIFY_API_TOKEN not found")
    sys.exit(1)

from mad_analytics.scrapers.instagram import (
    scrape_profiles_apify,
    scrape_posts_apify,
    scrape_all_artists,
    InstagramProfile,
    _resolve_username,
    _get_username_map,
)


def safe(val: str, maxlen: int = 80) -> str:
    """Safely convert value to ASCII-printable string."""
    if val is None:
        return ""
    s = str(val)
    s = s.encode("ascii", errors="replace").decode("ascii")
    if len(s) > maxlen:
        s = s[:maxlen] + "..."
    return s


def test_helper_functions():
    """Test username resolution and mapping."""
    print("\n=== Test Helper Functions ===")

    cases = [
        ("Diljit Dosanjh", "diljitdosanjh"),
        ("Arijit Singh", "arijitsingh"),
        ("Taylor Swift", "taylorswift"),
        ("Drake", "champagnepapi"),
        ("Unknown Artist", "unknownartist"),
    ]
    for name, expected in cases:
        result = _resolve_username(name)
        status = "OK" if result == expected else "FAIL"
        print(f"  [{status}] {name:25s} -> @{result}")
        if result != expected:
            print(f"    Expected: @{expected}")

    usermap = _get_username_map()
    print(f"\n  Username map size: {len(usermap)} entries")
    print(f"  Sample: diljit dosanjh -> @{usermap.get('diljit dosanjh', 'NOT FOUND')}")


def test_scrape_single_profile():
    """Test scraping a single profile via Apify."""
    print("\n=== Test Scrape Single Profile ===")
    print("  (cost: ~$0.0016)")

    usernames = ["diljitdosanjh"]
    items = scrape_profiles_apify(usernames, API_TOKEN)

    if not items:
        print("  [FAIL] No profile data returned")
        return None

    item = items[0]
    print(f"  [OK] Profile found for @{item.get('username', '?')}")
    print(f"    Full name: {safe(item.get('fullName', 'N/A'))}")
    print(f"    Followers: {int(item.get('followersCount', 0)):,}")
    print(f"    Following: {int(item.get('followsCount', 0)):,}")
    print(f"    Posts: {int(item.get('postsCount', 0)):,}")
    print(f"    Verified: {item.get('verified', False)}")
    print(f"    Bio: {safe(item.get('biography', ''), 100)}")

    print(f"\n    Raw Apify profile fields ({len(item)} keys):")
    for key, val in sorted(item.items()):
        print(f"      [{key}] = {safe(str(val), 100)}")

    return item


def test_scrape_posts():
    """Test scraping posts for a user via Apify."""
    print("\n=== Test Scrape Posts ===")
    print("  (cost: ~$0.001 per 10 posts)")

    usernames = ["diljitdosanjh"]
    items = scrape_posts_apify(usernames, API_TOKEN, posts_per_user=5)

    if not items:
        print("  [FAIL] No post data returned")
        return None

    print(f"  [OK] {len(items)} posts returned")

    for i, post in enumerate(items[:3]):
        print(f"\n  --- Post {i + 1} ---")
        print(f"    Type: {post.get('type', '?')}")
        print(f"    Likes: {int(post.get('likesCount', 0)):,}")
        print(f"    Comments: {int(post.get('commentsCount', 0)):,}")
        print(f"    Caption: {safe(post.get('caption', ''), 60)}")
        print(f"    Timestamp: {post.get('timestamp', '?')}")
        print(f"    URL: {post.get('url', '?')}")

        # Check for reshare/send/save fields
        reshare_keys = [k for k in post if any(x in k.lower() for x in ["share", "reshare", "send", "save", "bookmark"])]
        if reshare_keys:
            print(f"    [RESHARE/SAVE/SEND FIELDS]:")
            for k in reshare_keys:
                print(f"      {k} = {post.get(k)}")
        else:
            print(f"    No reshare/send/save/ bookmark fields found in Apify response")

        print(f"    All post fields ({len(post)} keys):")
        for key, val in sorted(post.items()):
            print(f"      [{key}] = {safe(str(val), 100)}")

    return items


def test_scrape_all_artists():
    """Test full scrape with mock artist list (2 artists)."""
    print("\n=== Test Full Scrape (2 Artists) ===")

    artists = [
        {"artistName": "Diljit Dosanjh", "id": "test-1"},
        {"artistName": "Taylor Swift", "id": "test-2"},
    ]

    profiles = scrape_all_artists(artists, api_token=API_TOKEN)

    print(f"\n  Profiles returned: {len(profiles)}")
    for p in profiles:
        status = "OK" if p.success else "FAIL"
        print(f"\n  [{status}] @{p.username}")
        print(f"     Followers: {p.followers:,}")
        print(f"     Following: {p.following:,}")
        print(f"     Posts: {p.posts_count:,}")
        print(f"     Avg Likes: {p.avg_likes:,.0f}")
        print(f"     Avg Comments: {p.avg_comments:,.0f}")
        print(f"     Avg Video Views: {p.avg_video_views:,.0f}")
        print(f"     Engagement Rate: {p.engagement_rate:.3f}%")
        print(f"     Posts Scraped: {p.posts_scraped}")
        print(f"     Full Name: {safe(p.full_name)}")
        print(f"     Verified: {p.is_verified}")
        print(f"     Error: {p.error or 'None'}")

    return profiles


def scrape_all_from_map():
    """Scrape all artists from the username map."""
    usermap = _get_username_map()
    artists = [{"artistName": name.capitalize(), "id": f"test-{i}"} for i, name in enumerate(usermap.keys())]

    print(f"\n{'='*100}")
    print(f"Scraping {len(artists)} artists from username map...")
    print(f"{'='*100}")

    profiles = scrape_all_artists(artists, api_token=API_TOKEN)

    successful = [p for p in profiles if p.success]
    failed = [p for p in profiles if not p.success]

    print(f"\n{'='*100}")
    print(f"{'Username':<22} {'Followers':>12} {'Posts':>6} {'Avg Likes':>10} {'Avg Cmts':>10} {'VidViews':>10} {'ER%':>8}  {'Name'}")
    print(f"{'-'*22} {'-'*12} {'-'*6} {'-'*10} {'-'*10} {'-'*10} {'-'*8}  {'-'*20}")
    for p in sorted(successful, key=lambda x: x.followers, reverse=True):
        print(
            f"@{p.username:<20} {p.followers:>12,} {p.posts_count:>6,} "
            f"{p.avg_likes:>10,.0f} {p.avg_comments:>10,.0f} "
            f"{p.avg_video_views:>10,.0f} {p.engagement_rate:>7.3f}%  {safe(p.full_name, 20)}"
        )

    if failed:
        print(f"\n  Failed ({len(failed)}):")
        for p in failed:
            print(f"    @{p.username}: {p.error}")

    print(f"\n{'='*100}")
    print(f"Successful: {len(successful)}/{len(artists)}  |  Failed: {len(failed)}")
    print(f"Estimated cost: ${len(successful) * 0.0016 + len(successful) * 10 * 0.001:.3f}")
    print(f"{'='*100}")

    return profiles


if __name__ == "__main__":
    print("=" * 60)
    print("Instagram Scraper - All Artists")
    print("=" * 60)
    print(f"API Token: {API_TOKEN[:12]}...{API_TOKEN[-4:]}")

    test_helper_functions()
    scrape_all_from_map()

    print("\nDone.")
