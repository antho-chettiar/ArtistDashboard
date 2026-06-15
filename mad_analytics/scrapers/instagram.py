"""
Instagram Scraper using Apify API.

Uses two Apify actors:
1. apify/instagram-profile-scraper → Username, Followers, Following, Posts count
2. apify/instagram-post-scraper → Latest 10 posts with likes, comments

Calculates:
- Avg Likes (from latest 10 posts)
- Avg Comments (from latest 10 posts)
- Engagement Rate = (Avg Likes + Avg Comments) / Followers × 100

Requirements:
- pip install apify-client
- APIFY_API_TOKEN in backend/.env

Pricing: ~$1.60/1000 profiles + ~$1.00/1000 posts
For 12 artists every 5 days: ~$0.02 per run (basically free)

Usage:
    python -m mad_analytics.scrapers.instagram
"""
from __future__ import annotations
import json
import logging
import os
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass
class InstagramProfile:
    """Complete Instagram profile with engagement metrics."""
    username: str
    followers: int = 0
    following: int = 0
    posts_count: int = 0
    full_name: str = ""
    bio: str = ""
    profile_pic_url: str = ""
    is_verified: bool = False
    # Engagement from latest posts
    avg_likes: float = 0.0
    avg_comments: float = 0.0
    avg_video_views: float = 0.0
    engagement_rate: float = 0.0
    posts_scraped: int = 0
    latest_posts: list[dict] = field(default_factory=list)
    # Status
    scraped_at: str = field(default_factory=lambda: datetime.now().isoformat())
    success: bool = False
    error: str = ""


def _get_username_map() -> dict[str, str]:
    """Map artist names (lowercase) to their Instagram usernames."""
    return {
        "diljit dosanjh": "diljitdosanjh",
        "arijit singh": "arijitsingh",
        "taylor swift": "taylorswift",
        "drake": "champagnepapi",
        "badshah": "badboyshah",
        "ap dhillon": "apdhillon",
        "karan aujla": "karanaujla",
        "shreya ghoshal": "shreyaghoshal",
        "anuv jain": "anuvjain",
        "prateek kuhad": "prateekkuhad",
        "sunidhi chauhan": "sunidhichauhan5",
        "sonu nigam": "sonunigamofficial",
        "a. r. rahman": "arrahman",
        "a.r. rahman": "arrahman",
        "ar rahman": "arrahman",
        "javed ali": "javedali4u",
        "ed sheeran": "teddysphotos",
        "coldplay": "coldplay",
        "the weeknd": "theweeknd",
        "billie eilish": "billieeilish",
        "bts": "bts.bighitofficial",
        "bad bunny": "badbunnypr",
        "harry styles": "harrystyles",
        "olivia rodrigo": "oliviarodrigo",
        "travis scott": "travisscott",
        "post malone": "postmalone",
        "dua lipa": "dualipa",
        "ariana grande": "arianagrande",
        "justin bieber": "justinbieber",
        "selena gomez": "selenagomez",
        "rihanna": "badgalriri",
        "beyonce": "beyonce",
        "eminem": "eminem",
        "bruno mars": "brunomars",
    }


def _resolve_username(artist_name: str) -> str:
    """Get Instagram username for an artist name."""
    username_map = _get_username_map()
    username = username_map.get(artist_name.lower())
    if not username:
        username = artist_name.lower().replace(" ", "").replace("'", "").replace("-", "")
    return username


# ── APIFY INTEGRATION ────────────────────────────────────────────────────────

def scrape_profiles_apify(usernames: list[str], api_token: str) -> list[dict]:
    """
    Use Apify Instagram Profile Scraper to get profile data.
    Returns raw Apify response items.
    """
    try:
        from apify_client import ApifyClient
    except ImportError:
        logger.error("[Instagram] apify-client not installed. Run: pip install apify-client")
        return []

    client = ApifyClient(api_token)

    run_input = {"usernames": usernames}

    logger.info(f"[Instagram] Running Apify profile scraper for {len(usernames)} users...")

    try:
        run = client.actor("apify/instagram-profile-scraper").call(run_input=run_input)
        dataset_id = run.default_dataset_id if hasattr(run, 'default_dataset_id') else run["defaultDatasetId"]
        items = list(client.dataset(dataset_id).iterate_items())
        logger.info(f"[Instagram] Apify profile scraper returned {len(items)} profiles.")
        return items
    except Exception as e:
        logger.error(f"[Instagram] Apify profile scraper error: {e}")
        return []


def scrape_posts_apify(usernames: list[str], api_token: str, posts_per_user: int = 10) -> list[dict]:
    """
    Use Apify Instagram Post Scraper to get latest posts with likes/comments.
    Returns raw Apify response items.
    """
    try:
        from apify_client import ApifyClient
    except ImportError:
        logger.error("[Instagram] apify-client not installed. Run: pip install apify-client")
        return []

    client = ApifyClient(api_token)

    run_input = {
        "username": usernames,
        "resultsLimit": posts_per_user,
    }

    logger.info(f"[Instagram] Running Apify post scraper for {len(usernames)} users ({posts_per_user} posts each)...")

    try:
        run = client.actor("apify/instagram-post-scraper").call(run_input=run_input)
        dataset_id = run.default_dataset_id if hasattr(run, 'default_dataset_id') else run["defaultDatasetId"]
        items = list(client.dataset(dataset_id).iterate_items())
        logger.info(f"[Instagram] Apify post scraper returned {len(items)} posts.")
        return items
    except Exception as e:
        logger.error(f"[Instagram] Apify post scraper error: {e}")
        return []


def scrape_all_artists(artists: list[dict], api_token: str | None = None) -> list[InstagramProfile]:
    """
    Scrape Instagram data for all artists using Apify.
    
    Step 1: Get profile data (followers, following, posts count)
    Step 2: Get latest 10 posts per user (likes, comments)
    Step 3: Calculate engagement rate
    """
    if not api_token:
        api_token = os.environ.get("APIFY_API_TOKEN")
    if not api_token:
        logger.error("[Instagram] APIFY_API_TOKEN not set. Cannot scrape.")
        return []

    # Resolve usernames
    username_map = _get_username_map()
    artist_usernames: list[tuple[dict, str]] = []
    for artist in artists:
        name = artist.get("artistName", "")
        username = _resolve_username(name)
        artist_usernames.append((artist, username))

    usernames = [u for _, u in artist_usernames]

    # Step 1: Scrape profiles
    profile_data = scrape_profiles_apify(usernames, api_token)

    # Build lookup by username
    profile_lookup: dict[str, dict] = {}
    for item in profile_data:
        uname = item.get("username", "").lower()
        if uname:
            profile_lookup[uname] = item

    # Step 2: Scrape latest posts
    post_data = scrape_posts_apify(usernames, api_token, posts_per_user=20)

    # Group posts by owner username
    posts_by_user: dict[str, list[dict]] = {}
    for post in post_data:
        owner = (post.get("ownerUsername") or post.get("username") or "").lower()
        if owner:
            posts_by_user.setdefault(owner, []).append(post)

    # Step 3: Build profiles with engagement
    results: list[InstagramProfile] = []

    for artist, username in artist_usernames:
        profile = InstagramProfile(username=username)
        pdata = profile_lookup.get(username.lower())

        if pdata:
            profile.followers = int(pdata.get("followersCount") or pdata.get("followers") or 0)
            profile.following = int(pdata.get("followsCount") or pdata.get("following") or 0)
            profile.posts_count = int(pdata.get("postsCount") or pdata.get("posts") or 0)
            profile.full_name = pdata.get("fullName") or pdata.get("name") or ""
            profile.bio = pdata.get("biography") or pdata.get("bio") or ""
            profile.profile_pic_url = pdata.get("profilePicUrl") or ""
            profile.is_verified = bool(pdata.get("verified") or pdata.get("isVerified"))
            profile.success = True
        else:
            profile.error = f"Profile not found in Apify response"
            logger.warning(f"[Instagram] @{username}: Not found in Apify profile data")

        # Calculate engagement from posts
        user_posts = posts_by_user.get(username.lower(), [])
        if user_posts:
            likes_list = []
            comments_list = []
            video_views_list = []

            for post in user_posts[:20]:
                likes = int(post.get("likesCount") or post.get("likes") or 0)
                comments = int(post.get("commentsCount") or post.get("comments") or 0)
                video_views = int(post.get("videoViewCount") or post.get("videoPlayCount") or 0)

                likes_list.append(likes)
                comments_list.append(comments)

                if video_views > 0:
                    video_views_list.append(video_views)

                profile.latest_posts.append({
                    "likes": likes,
                    "comments": comments,
                    "video_views": video_views,
                    "caption": (post.get("caption") or "")[:100],
                    "timestamp": post.get("timestamp") or post.get("date") or "",
                    "url": post.get("url") or post.get("postUrl") or "",
                    "type": post.get("type", ""),
                })

            profile.posts_scraped = len(likes_list)

            if likes_list:
                profile.avg_likes = round(sum(likes_list) / len(likes_list), 1)
            if comments_list:
                profile.avg_comments = round(sum(comments_list) / len(comments_list), 1)
            if video_views_list:
                profile.avg_video_views = round(sum(video_views_list) / len(video_views_list), 1)

            # Engagement Rate = (Avg Likes + Avg Comments) / Followers × 100
            if profile.followers > 0:
                profile.engagement_rate = round(
                    (profile.avg_likes + profile.avg_comments) / profile.followers * 100, 4
                )

        if profile.success:
            logger.info(
                f"[Instagram] @{username}: {profile.followers:,} followers, "
                f"{profile.posts_scraped} posts scraped, "
                f"avg_likes={profile.avg_likes:,.0f}, avg_comments={profile.avg_comments:,.0f}, "
                f"avg_video_views={profile.avg_video_views:,.0f}, "
                f"ER={profile.engagement_rate:.3f}%"
            )

        results.append(profile)

    return results


def update_artists_in_db(profiles: list[InstagramProfile], artists: list[dict], db_url: str) -> int:
    """
    Update Instagram data in the database:
    - artists.instagramFollowers — latest follower count
    - platform_metrics — full engagement snapshot for historical tracking
    """
    from sqlalchemy import create_engine, text as sql_text

    normalized = db_url.replace("postgres://", "postgresql://", 1) if db_url.startswith("postgres://") else db_url
    engine = create_engine(normalized)

    username_map = _get_username_map()
    updated = 0

    with engine.begin() as conn:
        for artist in artists:
            name = artist.get("artistName", "")
            artist_id = artist.get("id", "")

            username = _resolve_username(name)
            matching = next((p for p in profiles if p.username == username and p.success), None)

            if not matching or matching.followers == 0:
                continue

            # Update artists.instagramFollowers
            conn.execute(sql_text("""
                UPDATE artists
                SET "instagramFollowers" = :followers,
                    "lastUpdated" = NOW()
                WHERE id = :id
            """), {"followers": matching.followers, "id": artist_id})

            # Store full snapshot in platform_metrics
            # likes column = avg_likes, comments column = avg_comments
            conn.execute(sql_text("""
                INSERT INTO platform_metrics (
                    id, "artistId", platform, "metricDate",
                    followers, likes, comments, source, "rawSnapshot"
                )
                VALUES (
                    gen_random_uuid(), :artist_id, 'INSTAGRAM', CURRENT_DATE,
                    :followers, :likes, :comments, 'API', :snapshot
                )
                ON CONFLICT ("artistId", platform, "metricDate") DO UPDATE
                SET followers = EXCLUDED.followers,
                    likes = EXCLUDED.likes,
                    comments = EXCLUDED.comments,
                    "rawSnapshot" = EXCLUDED."rawSnapshot"
            """), {
                "artist_id": artist_id,
                "followers": matching.followers,
                "likes": int(matching.avg_likes),
                "comments": int(matching.avg_comments),
                "snapshot": json.dumps({
                    "username": matching.username,
                    "full_name": matching.full_name,
                    "followers": matching.followers,
                    "following": matching.following,
                    "posts_count": matching.posts_count,
                    "is_verified": matching.is_verified,
                    "avg_likes": matching.avg_likes,
                    "avg_comments": matching.avg_comments,
                    "avg_video_views": matching.avg_video_views,
                    "engagement_rate": matching.engagement_rate,
                    "posts_scraped": matching.posts_scraped,
                    "latest_posts": matching.latest_posts,
                    "scraped_at": matching.scraped_at,
                }),
            })

            updated += 1
            logger.info(
                f"[Instagram] DB updated: {name} — "
                f"{matching.followers:,} followers, ER={matching.engagement_rate:.3f}%"
            )

    engine.dispose()
    return updated


def run_instagram_scraper_job(db_url: str | None = None) -> dict:
    """
    Full pipeline: fetch artists from DB → Apify scrape → calculate engagement → update DB.
    
    No Instagram account needed. Uses Apify API ($0.02 per run for 12 artists).
    """
    if not db_url:
        db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        return {"error": "DATABASE_URL not set", "updated": 0}

    api_token = os.environ.get("APIFY_API_TOKEN")
    if not api_token:
        return {"error": "APIFY_API_TOKEN not set. Get it from https://console.apify.com/settings/integrations", "updated": 0}

    from sqlalchemy import create_engine, text as sql_text

    normalized = db_url.replace("postgres://", "postgresql://", 1) if db_url.startswith("postgres://") else db_url
    engine = create_engine(normalized)

    with engine.connect() as conn:
        artists = [
            dict(r) for r in conn.execute(
                sql_text('SELECT id, "artistName" FROM artists WHERE active = true')
            ).mappings().all()
        ]
    engine.dispose()

    if not artists:
        return {"error": "No active artists found", "updated": 0}

    logger.info(f"[Instagram] Starting Apify scrape for {len(artists)} artists...")
    profiles = scrape_all_artists(artists, api_token=api_token)

    successful = [p for p in profiles if p.success]
    failed = [p for p in profiles if not p.success]
    with_engagement = [p for p in profiles if p.posts_scraped > 0]

    updated = 0
    if successful:
        updated = update_artists_in_db(profiles, artists, db_url)

    summary = {
        "total_artists": len(artists),
        "scraped_successfully": len(successful),
        "with_engagement": len(with_engagement),
        "failed": len(failed),
        "updated_in_db": updated,
        "failed_usernames": [p.username for p in failed],
        "scraped_at": datetime.now().isoformat(),
        "profiles": [
            {
                "username": p.username,
                "followers": p.followers,
                "following": p.following,
                "posts": p.posts_count,
                "avg_likes": p.avg_likes,
                "avg_comments": p.avg_comments,
                "avg_video_views": p.avg_video_views,
                "engagement_rate": p.engagement_rate,
                "posts_scraped": p.posts_scraped,
            }
            for p in successful
        ],
    }

    logger.info(
        f"[Instagram] Done: {updated}/{len(artists)} updated. "
        f"Engagement: {len(with_engagement)}/{len(successful)}. "
        f"Failed: {[p.username for p in failed]}"
    )

    return summary


# ── CLI Entry Point ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys
    sys.path.insert(0, str(Path(__file__).parent.parent.parent))

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")

    # Load env
    env_path = Path(__file__).parent.parent.parent / "backend" / ".env"
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

    api_token = os.environ.get("APIFY_API_TOKEN")
    if not api_token:
        print("ERROR: APIFY_API_TOKEN not set in environment or backend/.env")
        print("  1. Sign up at https://console.apify.com (free $5 credit)")
        print("  2. Get your API token from Settings > Integrations")
        print("  3. Add to backend/.env: APIFY_API_TOKEN=your_token_here")
        sys.exit(1)

    print(f"Instagram Scraper (Apify)")
    print("=" * 60)

    result = run_instagram_scraper_job()

    if result.get("error"):
        print(f"\nERROR: {result['error']}")
        sys.exit(1)

    print(f"\n{'='*100}")
    print(f"{'Username':<22} {'Followers':>12} {'Posts':>6} {'Avg Likes':>10} {'Avg Cmts':>10} {'VidViews':>10} {'ER%':>8}")
    print(f"{'-'*22} {'-'*12} {'-'*6} {'-'*10} {'-'*10} {'-'*10} {'-'*8}")
    for p in result.get("profiles", []):
        print(
            f"@{p['username']:<20} {p['followers']:>12,} {p['posts']:>6,} "
            f"{p['avg_likes']:>10,.0f} {p['avg_comments']:>10,.0f} "
            f"{p['avg_video_views']:>10,.0f} {p['engagement_rate']:>7.3f}%"
        )

    print(f"\nTotal: {result.get('updated_in_db', 0)} artists updated in DB")
    print(f"Cost: ~${len(result.get('profiles', [])) * 0.0016 + len(result.get('profiles', [])) * 10 * 0.001:.3f}")
