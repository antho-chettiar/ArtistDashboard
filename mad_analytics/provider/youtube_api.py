"""YouTube Data API v3 scraper for public channel stats."""
from __future__ import annotations
import json
import logging
import os
import time
from datetime import datetime
from typing import Optional

import requests

logger = logging.getLogger(__name__)

YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3"


def _get_api_key() -> str:
    key = os.environ.get("YOUTUBE_API_KEY")
    if not key:
        raise RuntimeError("YOUTUBE_API_KEY environment variable not set")
    return key


def _youtube_get(endpoint: str, params: dict) -> dict:
    """Make a GET request to the YouTube Data API and return JSON."""
    key = _get_api_key()
    params["key"] = key
    url = f"{YOUTUBE_API_BASE}/{endpoint}"
    resp = requests.get(url, params=params, timeout=30)
    if resp.status_code == 403:
        body = resp.json()
        if "quotaExceeded" in str(body):
            raise RuntimeError("YouTube API quota exceeded")
        raise RuntimeError(f"YouTube API 403: {body}")
    resp.raise_for_status()
    return resp.json()


def _get_channel_ids() -> dict[str, str]:
    """Map artist names (lowercase) to known YouTube channel IDs.
    
    Using channel IDs directly avoids search API issues (quota,
    wrong matches). Populated with verified official channels.
    """
    return {
        "diljit dosanjh": "UCZRdNleCgW-BGUJf-bbjzQg",
        "taylor swift": "UCqECaJ8Gagnn7YCbPEzWH6g",
        "drake": "UCByOQJjav0CUDwxCk-jVNRQ",
        "shreya ghoshal": "UCcL78rRNuUQ8t7Dx4CLmRqA",
        "anuv jain": "UCafUh796DToiY2U3s7X_WTw",
        "prateek kuhad": "UCMwXzQYeZJ7ml7kQObcvXjA",
        "vishal mishra": "UCx4xrSYSfLATFO9fmPZxeNQ",
        "sunidhi chauhan": "UCOy7uPsjass2DCY4a_UUp-Q",
        "arijit singh": "UCtFOW7jJXChfFNoucRFqRmw",
        "badshah": "UCUQg_UBQfVjptn7Wqcgzz-w",
        "sonu nigam": "UCDYFISYJx2tSc6cyhvx0N5Q",
        "javed ali": "UCRtmCZR613ebOuSydaL-L3g",
        "a. r. rahman": "UC3mb5QRlm4VQmOZD_P0ctGw",
        "ar rahman": "UC3mb5QRlm4VQmOZD_P0ctGw",
    }


def _get_channel_search_terms() -> dict[str, str]:
    """Map artist names to search terms for finding channels."""
    return {
        "taylor swift": "Taylor Swift",
        "drake": "Drake",
        "diljit dosanjh": "Diljit Dosanjh",
        "arijit singh": "Arijit Singh",
        "shreya ghoshal": "Shreya Ghoshal",
        "sonu nigam": "Sonu Nigam",
        "a. r. rahman": "AR Rahman",
        "ar rahman": "AR Rahman",
        "anuv jain": "Anuv Jain",
        "javed ali": "Javed Ali",
        "sunidhi chauhan": "Sunidhi Chauhan",
        "vishal mishra": "Vishal Mishra",
        "badshah": "Badshah",
        "prateek kuhad": "Prateek Kuhad",
    }


def find_channel_id(artist_name: str) -> Optional[str]:
    """Find YouTube channel ID for an artist.
    
    First checks known channel IDs map, then falls back to Search API.
    """
    key = artist_name.strip().lower()
    
    # Check known channel IDs first
    known = _get_channel_ids()
    if key in known:
        logger.info(f"[YouTube API] Using known channel ID for '{artist_name}': {known[key]}")
        return known[key]
    
    # Fall back to Search API
    search_terms = _get_channel_search_terms()
    search_query = search_terms.get(key, artist_name)

    data = _youtube_get("search", {
        "part": "snippet",
        "q": search_query,
        "type": "channel",
        "maxResults": 3,
    })

    items = data.get("items", [])
    if not items:
        logger.warning(f"[YouTube API] No channel found for '{artist_name}'")
        return None

    for item in items:
        snippet = item.get("snippet", {})
        title = snippet.get("title", "")
        if " - Topic" in title:
            continue
        channel_id = item["id"]["channelId"]
        logger.info(f"[YouTube API] Found channel for '{artist_name}': {title} ({channel_id})")
        return channel_id

    first = items[0]
    channel_id = first["id"]["channelId"]
    logger.info(f"[YouTube API] Using best-match for '{artist_name}': {channel_id}")
    return channel_id


def get_channel_stats(channel_id: str) -> dict:
    """Get subscriber count, total views, and video count."""
    data = _youtube_get("channels", {
        "part": "statistics",
        "id": channel_id,
    })

    items = data.get("items", [])
    if not items:
        raise ValueError(f"No channel data found for ID {channel_id}")

    stats = items[0]["statistics"]
    return {
        "subscriber_count": int(stats.get("subscriberCount", 0)),
        "total_views": int(stats.get("viewCount", 0)),
        "video_count": int(stats.get("videoCount", 0)),
    }


def get_latest_videos(channel_id: str, max_results: int = 10) -> list[dict]:
    """Get the latest N videos from a channel with view/like/comment counts."""
    search_data = _youtube_get("search", {
        "part": "snippet",
        "channelId": channel_id,
        "order": "date",
        "maxResults": max_results,
        "type": "video",
    })

    items = search_data.get("items", [])
    if not items:
        return []

    video_ids = [item["id"]["videoId"] for item in items if "id" in item]
    if not video_ids:
        return []

    video_data = _youtube_get("videos", {
        "part": "statistics,snippet",
        "id": ",".join(video_ids),
    })

    videos = []
    for item in video_data.get("items", []):
        snippet = item.get("snippet", {})
        stats = item.get("statistics", {})
        videos.append({
            "video_id": item.get("id", ""),
            "title": snippet.get("title", ""),
            "published_at": snippet.get("publishedAt", ""),
            "views": int(stats.get("viewCount", 0)),
            "likes": int(stats.get("likeCount", 0)),
            "comments": int(stats.get("commentCount", 0)),
        })

    return videos


def fetch_artist_youtube_data(artist_name: str) -> dict:
    """Fetch all YouTube data for a single artist.
    
    Returns dict with channel_id, subscriber_count, total_views,
    video_count, latest_videos, fetched_at; or empty dict on failure.
    """
    try:
        channel_id = find_channel_id(artist_name)
        if not channel_id:
            return {}

        stats = get_channel_stats(channel_id)
        time.sleep(0.5)
        videos = get_latest_videos(channel_id)

        return {
            "channel_id": channel_id,
            "subscriber_count": stats["subscriber_count"],
            "total_views": stats["total_views"],
            "video_count": stats["video_count"],
            "latest_videos": videos,
            "fetched_at": datetime.now().isoformat(),
        }
    except Exception as e:
        logger.error(f"[YouTube API] Error for '{artist_name}': {e}")
        return {}


def fetch_all_artists(db_url: str) -> list[dict]:
    """Fetch all active artists from the database."""
    from sqlalchemy import create_engine, text as sql_text

    normalized = db_url.replace("postgres://", "postgresql://", 1) if db_url.startswith("postgres://") else db_url
    engine = create_engine(normalized)

    with engine.connect() as conn:
        rows = conn.execute(sql_text("""
            SELECT id, "artistName"
            FROM artists WHERE active = true
            ORDER BY "artistName"
        """)).mappings().all()

    engine.dispose()
    return [dict(r) for r in rows]


def store_youtube_data(artist_id: str, artist_name: str, data: dict, db_url: str) -> bool:
    """Store YouTube data into platform_metrics and update artists table."""
    if not data:
        return False

    from sqlalchemy import create_engine, text as sql_text

    normalized = db_url.replace("postgres://", "postgresql://", 1) if db_url.startswith("postgres://") else db_url
    engine = create_engine(normalized)

    with engine.begin() as conn:
        conn.execute(sql_text("""
            INSERT INTO platform_metrics (
                id, "artistId", platform, "metricDate",
                followers, streams, source, "rawSnapshot"
            )
            VALUES (
                gen_random_uuid(), :artist_id, 'YOUTUBE', CURRENT_DATE,
                :followers, :streams, 'API', :snapshot
            )
            ON CONFLICT ("artistId", platform, "metricDate") DO UPDATE
            SET followers = EXCLUDED.followers,
                streams = EXCLUDED.streams,
                "rawSnapshot" = EXCLUDED."rawSnapshot"
        """), {
            "artist_id": artist_id,
            "followers": data["subscriber_count"],
            "streams": data["total_views"],
            "snapshot": json.dumps({
                "channel_id": data["channel_id"],
                "subscriber_count": data["subscriber_count"],
                "total_views": data["total_views"],
                "video_count": data["video_count"],
                "latest_videos": data["latest_videos"],
                "fetched_at": data["fetched_at"],
            }),
        })

        conn.execute(sql_text("""
            UPDATE artists
            SET "youtubeSubscribers" = :subs,
                "lastUpdated" = NOW()
            WHERE id = :id
        """), {"subs": data["subscriber_count"], "id": artist_id})

    engine.dispose()
    logger.info(
        f"[YouTube API] Stored '{artist_name}': "
        f"{data['subscriber_count']:,} subs, {data['total_views']:,} views, "
        f"{len(data['latest_videos'])} videos"
    )
    return True


def fetch_and_store_all(db_url: str) -> int:
    """Fetch YouTube data for all active artists and store in DB. Returns success count."""
    artists = fetch_all_artists(db_url)
    logger.info(f"[YouTube API] Processing {len(artists)} artists...")

    success_count = 0
    for i, artist in enumerate(artists):
        name = artist.get("artistName", "")
        aid = artist.get("id", "")
        if not name or not aid:
            continue

        logger.info(f"[YouTube API] ({i+1}/{len(artists)}) '{name}'...")
        data = fetch_artist_youtube_data(name)
        if store_youtube_data(aid, name, data, db_url):
            success_count += 1

        if i < len(artists) - 1:
            time.sleep(1.0)

    logger.info(f"[YouTube API] Done: {success_count}/{len(artists)} artists updated.")
    return success_count


def _load_env_if_needed():
    """Load environment variables from backend/.env if not already set."""
    if os.environ.get("YOUTUBE_API_KEY"):
        return
    env_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
        "backend", ".env",
    )
    if os.path.exists(env_path):
        with open(env_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, _, v = line.partition("=")
                    k = k.strip()
                    v = v.strip().strip('"').strip("'")
                    if k and not os.environ.get(k):
                        os.environ[k] = v


def main():
    """CLI: python -m mad_analytics.provider.youtube_api"""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s: %(message)s",
    )

    _load_env_if_needed()

    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("ERROR: DATABASE_URL not set"); return

    try:
        _get_api_key()
    except RuntimeError as e:
        print(f"ERROR: {e}")
        print("Set YOUTUBE_API_KEY in environment or backend/.env")
        return

    fetch_and_store_all(db_url)


if __name__ == "__main__":
    main()
