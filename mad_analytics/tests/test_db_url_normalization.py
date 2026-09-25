"""
Regression test for the 2026-09-25 production incident: SQLAlchemy 2.1.0
(published that day; the unpinned `sqlalchemy>=2.0.0` requirement picked it
up on Render's next fresh build) changed the DEFAULT dialect for a bare
"postgresql://" URL from psycopg2 to psycopg v3. This service only ships
psycopg2-binary (requirements.txt, now also capped <2.1.0 as a second guard),
so _normalize_db_url must always pin the driver explicitly to
"postgresql+psycopg2" rather than relying on whatever the installed
SQLAlchemy's default happens to be.
"""
from mad_analytics.utils.db import _normalize_db_url


def test_forces_psycopg2_driver_on_bare_postgresql_url():
    result = _normalize_db_url("postgresql://user:pass@host:5432/db")
    assert result == "postgresql+psycopg2://user:pass@host:5432/db"


def test_forces_psycopg2_driver_replacing_unsupported_psycopg_v3_suffix():
    result = _normalize_db_url("postgresql+psycopg://user:pass@host:5432/db")
    assert result == "postgresql+psycopg2://user:pass@host:5432/db"


def test_forces_psycopg2_driver_with_query_params():
    result = _normalize_db_url("postgresql+psycopg://user:pass@host:5432/db?sslmode=require")
    assert result == "postgresql+psycopg2://user:pass@host:5432/db?sslmode=require"


def test_still_rewrites_postgres_scheme_to_postgresql_psycopg2():
    result = _normalize_db_url("postgres://user:pass@host:5432/db")
    assert result == "postgresql+psycopg2://user:pass@host:5432/db"


def test_already_explicit_psycopg2_url_unchanged():
    url = "postgresql+psycopg2://user:pass@host:5432/db"
    assert _normalize_db_url(url) == url


def test_still_strips_prisma_only_query_params():
    result = _normalize_db_url("postgresql+psycopg://user:pass@host:5432/db?pgbouncer=true&sslmode=require")
    assert result == "postgresql+psycopg2://user:pass@host:5432/db?sslmode=require"
