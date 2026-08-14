"""Database access helpers for MAD Analytics."""
from __future__ import annotations
import json
import os
from typing import Optional

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

from .schemas import PopularityOutput

DATABASE_URL_ENV = "DATABASE_URL"

# Conservative bounded pool for the shared engine. Total connections held by
# this process = pool_size + max_overflow = 5, which stays well under the
# Supabase Session Pooler's 15-client cap and leaves headroom for the Node
# backend that shares the same pooler. pool_pre_ping discards dead connections;
# pool_recycle refreshes them before the pooler's server-side idle timeout.
_POOL_KWARGS = dict(pool_size=3, max_overflow=2, pool_pre_ping=True, pool_recycle=1800)
_ENGINE: Optional[Engine] = None


def _normalize_db_url(db_url: str) -> str:
    if db_url.startswith("postgres://"):
        return db_url.replace("postgres://", "postgresql://", 1)
    return db_url


def _get_db_url(db_url: Optional[str] = None) -> str:
    if db_url:
        return _normalize_db_url(db_url)
    env_url = os.environ.get(DATABASE_URL_ENV)
    if not env_url:
        raise RuntimeError(
            f"Database URL is not configured. Set the {DATABASE_URL_ENV} environment variable."
        )
    return _normalize_db_url(env_url)


def get_engine(db_url: Optional[str] = None) -> Engine:
    """Return the process-wide shared SQLAlchemy Engine (created once, reused).

    This is SQLAlchemy's recommended pattern: a single long-lived Engine per
    database for the lifetime of the process, with a bounded connection pool.
    The popularity/demand request path MUST use this shared engine and MUST NOT
    dispose it (disposing would tear down the shared pool for every other
    request). When an explicit db_url is passed (CLI/one-off scripts), a
    dedicated bounded engine is returned that the caller owns and may dispose.
    """
    global _ENGINE
    if db_url is not None:
        return create_engine(_normalize_db_url(db_url), **_POOL_KWARGS)
    if _ENGINE is None:
        _ENGINE = create_engine(_get_db_url(), **_POOL_KWARGS)
    return _ENGINE


def fetch_artist_snapshots(db_url: Optional[str] = None) -> list[dict[str, object]]:
    """Fetch current artist platform snapshot values from the backend artist table."""
    engine = get_engine(db_url)
    query = text(
        """
        SELECT id AS artist_id, "artistName",
               "spotifyMonthlyListeners", "youtubeSubscribers",
               "instagramFollowers", "facebookFollowers",
               "twitterFollowers"
        FROM artists
        WHERE active = true
        """
    )
    with engine.connect() as conn:
        rows = conn.execute(query).mappings().all()
    if db_url is not None:
        engine.dispose()  # dedicated (CLI) engine only; never the shared one
    return [dict(row) for row in rows]


def _create_popularity_table_query(dialect_name: str) -> str:
    if dialect_name == "sqlite":
        return """
        CREATE TABLE IF NOT EXISTS artist_popularity_scores (
            artist_id TEXT PRIMARY KEY,
            popularity_score NUMERIC NOT NULL,
            platform_weights TEXT NOT NULL,
            platform_contributions TEXT NOT NULL,
            computed_at TEXT NOT NULL,
            inserted_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
        """

    return """
    CREATE TABLE IF NOT EXISTS artist_popularity_scores (
        artist_id TEXT PRIMARY KEY,
        popularity_score NUMERIC(5, 2) NOT NULL,
        platform_weights TEXT NOT NULL,
        platform_contributions TEXT NOT NULL,
        computed_at TIMESTAMPTZ NOT NULL,
        inserted_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """


def persist_popularity_scores(outputs: list[PopularityOutput], db_url: Optional[str] = None) -> int:
    """Persist a set of artist popularity outputs into the analytics database."""
    if not outputs:
        return 0

    engine = get_engine(db_url)
    create_table_q = _create_popularity_table_query(engine.dialect.name)
    with engine.begin() as conn:
        conn.execute(text(create_table_q))

        if engine.dialect.name == "sqlite":
            upsert_query = text(
                """
                INSERT OR REPLACE INTO artist_popularity_scores
                    (artist_id, popularity_score, platform_weights, platform_contributions, computed_at)
                VALUES
                    (:artist_id, :popularity_score, :platform_weights, :platform_contributions, :computed_at)
                """
            )
        else:
            upsert_query = text(
                """
                INSERT INTO artist_popularity_scores
                    (artist_id, popularity_score, platform_weights, platform_contributions, computed_at)
                VALUES
                    (:artist_id, :popularity_score, :platform_weights, :platform_contributions, :computed_at)
                ON CONFLICT (artist_id) DO UPDATE SET
                    popularity_score = EXCLUDED.popularity_score,
                    platform_weights = EXCLUDED.platform_weights,
                    platform_contributions = EXCLUDED.platform_contributions,
                    computed_at = EXCLUDED.computed_at,
                    inserted_at = now()
                """
            )

        for output in outputs:
            conn.execute(
                upsert_query,
                {
                    "artist_id": output.artist_id,
                    "popularity_score": float(output.popularity_score),
                    "platform_weights": json.dumps(output.platform_weights),
                    "platform_contributions": json.dumps(output.platform_contributions),
                    "computed_at": output.computed_at,
                },
            )

    if db_url is not None:
        engine.dispose()  # dedicated (CLI) engine only; never the shared one
    return len(outputs)


def fetch_saved_popularity(db_url: Optional[str] = None) -> list[dict[str, object]]:
    """Read the last-saved artist popularity scores from the analytics persistence table."""
    engine = get_engine(db_url)
    query = text(
        """
        SELECT artist_id, popularity_score, platform_weights, platform_contributions, computed_at, inserted_at
        FROM artist_popularity_scores
        ORDER BY popularity_score DESC, inserted_at DESC
        """
    )
    with engine.connect() as conn:
        rows = conn.execute(query).mappings().all()
    if db_url is not None:
        engine.dispose()  # dedicated (CLI) engine only; never the shared one
    results: list[dict[str, object]] = []
    for row in rows:
        results.append(
            {
                "artist_id": row["artist_id"],
                "popularity_score": float(row["popularity_score"]),
                "platform_weights": json.loads(row["platform_weights"]),
                "platform_contributions": json.loads(row["platform_contributions"]),
                "computed_at": row["computed_at"],
                "inserted_at": row["inserted_at"],
            }
        )
    return results
