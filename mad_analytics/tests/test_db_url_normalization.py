"""
Regression test for the 2026-09-25 production incident: DATABASE_URL with an
explicit "+psycopg" (v3) driver suffix broke every DB-touching endpoint on
this service with "No module named 'psycopg'" -- this service only ships
psycopg2-binary (requirements.txt), so _normalize_db_url must force the bare
"postgresql" scheme regardless of what driver suffix the raw env var carries.
"""
from mad_analytics.utils.db import _normalize_db_url


def test_strips_psycopg_v3_driver_suffix():
    result = _normalize_db_url("postgresql+psycopg://user:pass@host:5432/db")
    assert result == "postgresql://user:pass@host:5432/db"


def test_strips_driver_suffix_with_query_params():
    result = _normalize_db_url("postgresql+psycopg://user:pass@host:5432/db?sslmode=require")
    assert result == "postgresql://user:pass@host:5432/db?sslmode=require"


def test_still_rewrites_postgres_scheme_to_postgresql():
    result = _normalize_db_url("postgres://user:pass@host:5432/db")
    assert result == "postgresql://user:pass@host:5432/db"


def test_bare_postgresql_url_unchanged():
    url = "postgresql://user:pass@host:5432/db"
    assert _normalize_db_url(url) == url


def test_still_strips_prisma_only_query_params():
    result = _normalize_db_url("postgresql+psycopg://user:pass@host:5432/db?pgbouncer=true&sslmode=require")
    assert result == "postgresql://user:pass@host:5432/db?sslmode=require"
