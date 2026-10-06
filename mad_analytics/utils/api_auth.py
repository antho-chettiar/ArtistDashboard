"""
api_auth.py — shared-secret authentication for the analytics service.

Why this exists (2026-10-06 audit): every route on this service used to be
callable by anyone who knew its public URL, including the ones that start
scrapers, retrain the model, recompute and save popularity, or burn
third-party API quota (/scheduler/*, /popularity/refresh,
/popularity/all/save, /venue-capacity/enrich). The only legitimate caller is
the Node backend (backend/src/services/madAnalytics.service.ts), so the
service now requires an `X-Analytics-Key` header equal to the
ANALYTICS_API_KEY environment variable, set to the same value on both
services. Only /health stays open, because Render's uptime check needs it.

Rollout safety: if ANALYTICS_API_KEY is NOT set, ordinary routes keep
working exactly as before (so deploying this code cannot take production
down before the secret is configured), but the /scheduler/* job triggers --
which nothing in this codebase calls over HTTP -- are refused outright.
Setting the variable on both services is what actually closes the rest.
"""
from __future__ import annotations

import hmac
import os
from typing import Optional

from starlette.requests import Request
from starlette.responses import JSONResponse

API_KEY_HEADER = "X-Analytics-Key"
PUBLIC_PATHS = frozenset({"/health"})
# Job triggers with no HTTP caller anywhere in this repo: refused whenever no
# key is configured, rather than left open "for compatibility".
ALWAYS_PROTECTED_PREFIXES = ("/scheduler/",)


def configured_key() -> str:
    return os.environ.get("ANALYTICS_API_KEY", "").strip()


def authorize(
    method: str,
    path: str,
    supplied_key: Optional[str],
    key: str,
) -> Optional[tuple[int, str]]:
    """Pure decision: None if the request may proceed, else (status, message)."""
    if method.upper() == "OPTIONS":  # CORS preflight carries no credentials
        return None
    if path in PUBLIC_PATHS:
        return None

    if key:
        if supplied_key and hmac.compare_digest(supplied_key.encode(), key.encode()):
            return None
        return 401, f"Missing or invalid {API_KEY_HEADER}"

    if path.startswith(ALWAYS_PROTECTED_PREFIXES):
        return 503, "Disabled: ANALYTICS_API_KEY is not configured on this service"
    return None


async def api_key_middleware(request: Request, call_next):
    denied = authorize(
        request.method,
        request.url.path,
        request.headers.get(API_KEY_HEADER),
        configured_key(),
    )
    if denied is not None:
        status, message = denied
        return JSONResponse({"detail": message}, status_code=status)
    return await call_next(request)
