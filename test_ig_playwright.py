"""
Test Instagram scraper using Apify API.

Setup:
    1. Sign up at https://console.apify.com (free $5 credit)
    2. Get API token from Settings > Integrations
    3. Add to backend/.env: APIFY_API_TOKEN=your_token_here

Usage:
    python test_ig_playwright.py          # Run full scrape for all artists
    python test_ig_playwright.py --single # Test single profile only
"""
import sys
import os
import logging
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")

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


def test_single():
    """Test scraping a single profile."""
    from mad_analytics.scrapers.instagram import scrape_profiles_apify, scrape_posts_apify

    api_token = os.environ.get("APIFY_API_TOKEN")
    if not api_token:
        print("ERROR: APIFY_API_TOKEN not set")
        print("  Add to backend/.env: APIFY_API_TOKEN=your_token_here")
        return False

    username = "diljitdosanjh"
    print(f"Testing Apify scraper on @{username}...")
    print("=" * 50)

    # Profile
    print("\n[1/2] Fetching profile data...")
    profiles = scrape_profiles_apify([username], api_token)
    if profiles:
        p = profiles[0]
        print(f"  Username:     @{p.get('username')}")
        print(f"  Full Name:    {p.get('fullName')}")
        print(f"  Followers:    {p.get('followersCount', 0):,}")
        print(f"  Following:    {p.get('followsCount', 0):,}")
        print(f"  Posts:        {p.get('postsCount', 0):,}")
        print(f"  Verified:     {p.get('verified')}")
    else:
        print("  FAILED: No profile data returned")
        return False

    # Posts
    print(f"\n[2/2] Fetching latest 10 posts...")
    posts = scrape_posts_apify([username], api_token, posts_per_user=10)
    if posts:
        likes = [int(p.get("likesCount", 0) or 0) for p in posts]
        comments = [int(p.get("commentsCount", 0) or 0) for p in posts]
        avg_likes = sum(likes) / len(likes) if likes else 0
        avg_comments = sum(comments) / len(comments) if comments else 0
        followers = profiles[0].get("followersCount", 1)
        er = (avg_likes + avg_comments) / followers * 100 if followers else 0

        print(f"  Posts found:      {len(posts)}")
        print(f"  Avg Likes:        {avg_likes:,.0f}")
        print(f"  Avg Comments:     {avg_comments:,.0f}")
        print(f"  Engagement Rate:  {er:.4f}%")
        print(f"\n  Post breakdown:")
        for i, post in enumerate(posts[:10], 1):
            print(f"    Post {i}: {post.get('likesCount', 0):,} likes, {post.get('commentsCount', 0):,} comments")
    else:
        print("  FAILED: No post data returned")

    return True


def test_all():
    """Run full scraper for all artists."""
    from mad_analytics.scrapers.instagram import run_instagram_scraper_job

    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("ERROR: DATABASE_URL not set")
        return False

    api_token = os.environ.get("APIFY_API_TOKEN")
    if not api_token:
        print("ERROR: APIFY_API_TOKEN not set")
        return False

    print("Instagram Scraper (Apify) — All Artists")
    print("=" * 80)

    result = run_instagram_scraper_job(db_url=db_url)

    if result.get("error"):
        print(f"\nERROR: {result['error']}")
        return False

    print(f"\n{'='*80}")
    print(f"{'Username':<22} {'Followers':>12} {'Posts':>6} {'Avg Likes':>10} {'Avg Cmts':>10} {'ER%':>8}")
    print(f"{'-'*22} {'-'*12} {'-'*6} {'-'*10} {'-'*10} {'-'*8}")
    for p in result.get("profiles", []):
        print(
            f"@{p['username']:<20} {p['followers']:>12,} {p['posts']:>6,} "
            f"{p['avg_likes']:>10,.0f} {p['avg_comments']:>10,.0f} "
            f"{p['engagement_rate']:>7.3f}%"
        )

    print(f"\n  Updated in DB: {result.get('updated_in_db', 0)}")
    print(f"  With engagement: {result.get('with_engagement', 0)}")
    n = len(result.get('profiles', []))
    print(f"  Estimated cost: ~${n * 0.0016 + n * 10 * 0.001:.3f}")
    return True


if __name__ == "__main__":
    if "--single" in sys.argv:
        success = test_single()
    else:
        success = test_all()
    sys.exit(0 if success else 1)
