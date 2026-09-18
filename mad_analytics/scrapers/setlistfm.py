"""
Setlist.fm scraper — fetches past and upcoming concerts for tracked artists.
Uses the official Setlist.fm API (free, requires API key).

API docs: https://api.setlist.fm/docs/1.0/index.html
Rate limit: 2 requests/second

Get your API key at: https://www.setlist.fm/settings/api
"""
from __future__ import annotations

import json
import os
import re
import time
import logging
import urllib.request
import urllib.parse
from datetime import datetime
from typing import Optional

from .models import ScrapedConcert

logger = logging.getLogger(__name__)

SETLISTFM_API_KEY_ENV = "SETLISTFM_API_KEY"
BASE_URL = "https://api.setlist.fm/rest/1.0"


def _get_api_key() -> Optional[str]:
    return os.environ.get(SETLISTFM_API_KEY_ENV) or os.environ.get("SETLIST_API_KEY")


def _api_request(endpoint: str, params: dict = None, api_key: str = "") -> Optional[dict]:
    """Make a request to the Setlist.fm API."""
    url = f"{BASE_URL}/{endpoint}"
    if params:
        url += "?" + urllib.parse.urlencode(params)

    headers = {
        "Accept": "application/json",
        "x-api-key": api_key,
    }

    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        logger.warning(f"Setlist.fm API error {e.code}: {e.reason}")
        return None
    except Exception as e:
        logger.warning(f"Setlist.fm request failed: {e}")
        return None


def _search_artist(artist_name: str, api_key: str) -> Optional[str]:
    """Search for an artist on Setlist.fm and return their MBID."""
    data = _api_request("search/artists", {"artistName": artist_name, "sort": "relevance"}, api_key)
    if not data or not data.get("artist"):
        return None

    artists = data["artist"]
    if not artists:
        return None

    # Find best match (exact or close name match)
    for artist in artists:
        if artist.get("name", "").lower() == artist_name.lower():
            return artist.get("mbid")

    # Return first result if no exact match
    return artists[0].get("mbid") if artists else None


def _parse_setlist_date(date_str: str) -> Optional[str]:
    """Parse Setlist.fm date format (dd-MM-yyyy) to ISO."""
    if not date_str:
        return None
    try:
        dt = datetime.strptime(date_str, "%d-%m-%Y")
        return dt.strftime("%Y-%m-%d")
    except ValueError:
        return None


def fetch_artist_setlists(artist_name: str, api_key: str, page: int = 1) -> list[ScrapedConcert]:
    """Fetch ONE page of setlists (concerts) for an artist. Prefer
    fetch_all_artist_setlists() below for a complete history -- the
    Setlist.fm API caps each response at 20 setlists (itemsPerPage),
    newest first, so calling this alone silently drops everything past
    an artist's most recent 20 shows for anyone with a longer history."""
    concerts = []

    # First find the artist's MBID
    mbid = _search_artist(artist_name, api_key)
    if not mbid:
        logger.debug(f"  Artist not found on Setlist.fm: {artist_name}")
        return []

    time.sleep(0.5)  # Rate limit

    # Fetch their setlists
    data = _api_request(f"artist/{mbid}/setlists", {"p": str(page)}, api_key)
    if not data or not data.get("setlist"):
        return []

    for setlist in data["setlist"]:
        event_date = _parse_setlist_date(setlist.get("eventDate"))
        if not event_date:
            continue

        venue = setlist.get("venue", {})
        venue_name = venue.get("name", "")
        city_data = venue.get("city", {})
        city = city_data.get("name", "")
        country = city_data.get("country", {}).get("name", "")

        tour_name = setlist.get("tour", {}).get("name", "")
        event_name = tour_name or f"{artist_name} Live"
        if venue_name:
            event_name = f"{artist_name} at {venue_name}"

        source_url = setlist.get("url", "")

        concerts.append(ScrapedConcert(
            event_name=event_name,
            artist_name=artist_name,
            venue_name=venue_name,
            city=city,
            country=country or "Unknown",
            date=event_date,
            time=None,
            price_min=None,
            price_max=None,
            currency="INR" if "india" in country.lower() else "USD",
            source_url=source_url,
            source="setlistfm",
        ))

    return concerts


def fetch_all_artist_setlists(artist_name: str, api_key: str, max_pages: int = 20) -> list[ScrapedConcert]:
    """Fetch an artist's FULL setlist history across all pages (20/page),
    not just the most recent 20. max_pages is a hard safety cap (400 shows)
    against a runaway loop, not an expected ceiling for this roster."""
    mbid = _search_artist(artist_name, api_key)
    if not mbid:
        logger.debug(f"  Artist not found on Setlist.fm: {artist_name}")
        return []

    all_concerts: list[ScrapedConcert] = []
    page = 1
    while page <= max_pages:
        time.sleep(0.5)  # Rate limit: 2 req/sec max
        data = _api_request(f"artist/{mbid}/setlists", {"p": str(page)}, api_key)
        if not data or not data.get("setlist"):
            break

        for setlist in data["setlist"]:
            event_date = _parse_setlist_date(setlist.get("eventDate"))
            if not event_date:
                continue

            venue = setlist.get("venue", {})
            venue_name = venue.get("name", "")
            city_data = venue.get("city", {})
            city = city_data.get("name", "")
            country = city_data.get("country", {}).get("name", "")

            tour_name = setlist.get("tour", {}).get("name", "")
            event_name = tour_name or f"{artist_name} Live"
            if venue_name:
                event_name = f"{artist_name} at {venue_name}"

            all_concerts.append(ScrapedConcert(
                event_name=event_name,
                artist_name=artist_name,
                venue_name=venue_name,
                city=city,
                country=country or "Unknown",
                date=event_date,
                time=None,
                price_min=None,
                price_max=None,
                currency="INR" if "india" in country.lower() else "USD",
                source_url=setlist.get("url", ""),
                source="setlistfm",
            ))

        total_items = int(data.get("total", 0) or 0)
        items_per_page = int(data.get("itemsPerPage", 20) or 20)
        total_pages = -(-total_items // items_per_page) if items_per_page else page  # ceil div
        if page >= total_pages:
            break
        page += 1

    return all_concerts


def scrape_setlistfm(artists: list[dict]) -> list[ScrapedConcert]:
    """
    Scrape Setlist.fm for all tracked artists.

    Args:
        artists: List of dicts with 'id' and 'artistName' keys.

    Returns:
        List of ScrapedConcert objects.
    """
    api_key = _get_api_key()
    if not api_key:
        logger.warning("SETLISTFM_API_KEY not set. Skipping Setlist.fm scraping.")
        return []

    all_concerts: list[ScrapedConcert] = []

    for artist in artists:
        name = artist.get("artistName", "")
        if not name:
            continue

        logger.info(f"  Setlist.fm: {name}...")
        concerts = fetch_all_artist_setlists(name, api_key)
        all_concerts.extend(concerts)

        if concerts:
            logger.info(f"    Found {len(concerts)} concerts")

        time.sleep(1)  # Rate limit: 2 req/sec max

    logger.info(f"  Setlist.fm total: {len(all_concerts)} concerts")
    return all_concerts
