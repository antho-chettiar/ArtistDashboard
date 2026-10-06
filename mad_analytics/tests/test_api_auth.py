"""
Tests for the analytics service's shared-secret auth (utils/api_auth.py).

Pure-decision tests plus an isolated mini FastAPI app prove the rules; the real
app is only probed with requests that must be REFUSED, never with a valid key,
so no test can start a scraper or write to the production database.

Requests are sent straight into the ASGI app (no TestClient) so this file adds
no test-only dependency.
"""
import asyncio
import json

import pytest
from fastapi import FastAPI

from mad_analytics.utils.api_auth import API_KEY_HEADER, authorize, api_key_middleware

KEY = "unit-test-secret"


def call(app, method, path, key=None):
    """Send one HTTP request into an ASGI app; return (status, parsed JSON body)."""
    headers = [(API_KEY_HEADER.lower().encode(), key.encode())] if key is not None else []
    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
        "method": method, "scheme": "http", "path": path, "raw_path": path.encode(),
        "query_string": b"", "headers": headers, "server": ("test", 80), "client": ("test", 1),
    }
    sent = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        sent.append(message)

    asyncio.run(app(scope, receive, send))
    status = next(m["status"] for m in sent if m["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return status, (json.loads(body) if body else None)


class TestAuthorizeDecision:
    def test_health_is_always_open(self):
        assert authorize("GET", "/health", None, KEY) is None
        assert authorize("GET", "/health", None, "") is None

    def test_cors_preflight_is_never_blocked(self):
        assert authorize("OPTIONS", "/popularity", None, KEY) is None

    def test_missing_or_wrong_key_is_401_when_configured(self):
        assert authorize("POST", "/popularity", None, KEY)[0] == 401
        assert authorize("POST", "/popularity", "wrong", KEY)[0] == 401
        assert authorize("POST", "/popularity", "", KEY)[0] == 401

    def test_correct_key_passes(self):
        assert authorize("POST", "/popularity", KEY, KEY) is None
        assert authorize("POST", "/scheduler/scrape", KEY, KEY) is None

    def test_unconfigured_service_keeps_ordinary_routes_open(self):
        # Deploying this code before the secret exists must not cause an outage.
        assert authorize("POST", "/popularity", None, "") is None
        assert authorize("GET", "/dashboard/highlights", None, "") is None

    def test_unconfigured_service_still_refuses_scheduler_job_triggers(self):
        for path in ("/scheduler/scrape", "/scheduler/retrain", "/scheduler/google-trends"):
            assert authorize("POST", path, None, "")[0] == 503


class TestMiddlewareOnIsolatedApp:
    @pytest.fixture
    def app(self, monkeypatch):
        monkeypatch.setenv("ANALYTICS_API_KEY", KEY)
        app = FastAPI()
        app.middleware("http")(api_key_middleware)
        ran = []

        @app.get("/health")
        def health():
            return {"status": "ok"}

        @app.post("/work")
        def work():
            ran.append(True)
            return {"ran": True}

        app.state.ran = ran
        return app

    def test_health_open(self, app):
        assert call(app, "GET", "/health")[0] == 200

    def test_work_refused_without_key_and_never_runs(self, app):
        status, body = call(app, "POST", "/work")
        assert status == 401 and "ran" not in body
        assert app.state.ran == []

    def test_work_runs_with_correct_key(self, app):
        assert call(app, "POST", "/work", key=KEY) == (200, {"ran": True})
        assert app.state.ran == [True]

    def test_work_refused_with_wrong_key(self, app):
        assert call(app, "POST", "/work", key="nope")[0] == 401
        assert app.state.ran == []


class TestRealApp:
    """The real server must have the middleware installed. Only refusals are probed."""

    @pytest.fixture
    def real_app(self):
        from mad_analytics.server import app
        return app

    def test_scheduler_trigger_refused_without_key(self, real_app, monkeypatch):
        monkeypatch.setenv("ANALYTICS_API_KEY", KEY)
        assert call(real_app, "POST", "/scheduler/scrape")[0] == 401

    def test_scheduler_trigger_refused_even_when_unconfigured(self, real_app, monkeypatch):
        monkeypatch.delenv("ANALYTICS_API_KEY", raising=False)
        assert call(real_app, "POST", "/scheduler/retrain")[0] == 503

    def test_state_changing_routes_refused_without_key_when_configured(self, real_app, monkeypatch):
        monkeypatch.setenv("ANALYTICS_API_KEY", KEY)
        for path in ("/popularity/refresh", "/popularity/all/save", "/venue-capacity/enrich"):
            assert call(real_app, "POST", path)[0] == 401
        assert call(real_app, "GET", "/dashboard/highlights")[0] == 401

    def test_health_still_open_when_configured(self, real_app, monkeypatch):
        monkeypatch.setenv("ANALYTICS_API_KEY", KEY)
        assert call(real_app, "GET", "/health")[0] == 200
