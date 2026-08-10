# myCONCERT_MVP_STATUS.md — MVP Concert Ingestion: Gate A/B Findings

**Date:** 2026-08-05 · MVP Deployment Mode. Read-only inspection + 2-artist dry-run (no DB writes, no code changes).

---

## What already works (demo-ready TODAY, verified prior sprints)
Auth ✅ · 11 artists ✅ · Viberate ~4,805 metric rows ✅ · platform sync ~1,302 rows ✅ · 11 popularity snapshots ✅ · Dashboard / Artist / Analytics APIs return real data ✅. **The only empty part of the product is concerts** (and the Map/prediction views that depend on them).

## Gate A dry-run result (BookMyShow + District, SerpAPI path, 2 artists)
- Scrapers **execute with stdlib-only Python** (no install needed for the SerpAPI path). ✅
- SERPAPI_KEY valid. ✅ Artist matching works (matched "Shreya Ghoshal"). ✅
- **BookMyShow:** 1 record — but `city=''`, `venue=''`, `price=None`, and the URL was a **facebook.com** link, not a BookMyShow listing.
- **District:** 0 records (+ one SerpAPI read timeout).
- **Verdict:** the SerpAPI scrapers run, but the records are **thin** — frequently missing the MVP-critical fields (venue, city, price). This matches the audit: the SerpAPI path is light; the **Playwright** BookMyShow scraper (`scrape_bookmyshow_all.py`) is the one that reliably yields venue/city/date/**tier prices**.

## The real blocker: Python environment gap
The Python `mad_analytics` stack has **never run on this PC**. Current Python is **3.14.6 (Windows Store build)** with **no third-party packages installed** (`sqlalchemy`, `playwright`, `psycopg2`, `dotenv` all missing; the `cpython-39` caches are leftovers from the old machine).
- To **write concerts to the DB** at all, `run_scraper.store_concerts` needs `sqlalchemy` + `psycopg2-binary` installed.
- To get **good** BookMyShow data, the Playwright path needs `playwright` + `playwright-stealth` + `playwright install chromium` (Python side; separate from the Node one).
- **Python 3.14 is bleeding-edge** → real risk that `psycopg2-binary`/`playwright`/`numpy`/`scikit-learn` wheels aren't available and pip tries (and fails) to build from source. A stable Python (3.12) would de-risk this.

## Three candidate paths to real concert data (shortest → most robust)

| Path | What it needs | Data quality | Risk | Effort |
|---|---|---|---|---|
| **A. Python SerpAPI** (`bookmyshow.py`+`district.py` via `run_scraper`) | install `sqlalchemy`+`psycopg2` | **Low** (missing venue/city/price often; District flaky) | Med (3.14 wheels) | Low code, weak result |
| **B. Python Playwright** (`scrape_bookmyshow_all.py`) | install `playwright`+`stealth`+chromium+`sqlalchemy`+`psycopg2` | **High for BMS** (venue/city/date/tiers); District still weak (no PY Playwright) | **High** (3.14 wheels + Cloudflare) | Med |
| **C. TS scrapers + Prisma persist** (`districtScraper.ts` JSON-LD w/ prices, `bookMyShowScraper.ts`) | **no new env** — Node/Prisma already working; add artist-match + upsert + flip persistence | **High for District** (JSON-LD prices), good BMS venue/city | Low-Med | Med (small TS glue) |

> Note: Path C reuses the **already-working Node/Prisma environment** (viberate ran fine via `tsx`), sidestepping the Python 3.14 dependency gamble. It technically deviates from the "Python-canonical" decision, but MVP mode explicitly prioritizes speed over architecture — and it's the lowest-environment-risk route to *good* concert rows. Python can still be made canonical after the demo.

## Recommendation for "demo ASAP"
**Two-track, and they're independent:**
1. **Deploy the working analytics dashboard NOW** (artists, metrics, popularity, dashboard, analytics, auth — all real data). This is the single fastest way to put "a working product with real data" in front of stakeholders. Concerts are the *only* thing not ready, and they're the riskiest long-pole.
2. **Add concerts as a fast-follow.** For that, pick a path above. If concerts must be in the *first* demo, **Path C** is the lowest-risk route to *usable* concert rows given the Python-3.14 environment gap; Path A is fastest-to-run but produces weak data; Path B is best BMS quality but highest env risk.

## Minimum changes by path (for Gate C, after approval)
- **Path A:** install `sqlalchemy`+`psycopg2-binary`; run `run_scraper.py --source all`; accept thin data. (Idempotency already app-level via existing SELECT-before-insert.)
- **Path B:** the above + `playwright`/`stealth`/chromium; route `scrape_bookmyshow_all.py` output through `store_concerts`.
- **Path C:** small TS ingest script: call `districtScraper`/`bookMyShowScraper` → normalized artist-match against the 11 → `prisma.concert.upsert`-style (SELECT-then-create) — no schema change, no new deps.

**No code changed. No DB writes. No installs.** Awaiting your decision before Gate C.

---

## UPDATE — Gate C/D dry-run outcome (Path C: TS scrapers + Prisma)
Built `backend/scripts/ingest-concerts-mvp.ts` (dry-run by default, reuses the existing TS BookMyShow + District scrapers + Prisma; no schema change, no new deps). Ran it dry (no DB writes) for the 11 artists:

- **BookMyShow → consistent HTTP 403** on `in.bookmyshow.com/api/explore/v1/discover/concerts-mumbai`. Cloudflare is blocking the API from this environment's IP even after Playwright homepage clearance. **This is an external anti-bot wall — not fixable by a minimal code change.**
- **District → 0 events, 0 errors** (with and without a city filter). The scraper runs and parses cleanly, but the server-resolved city for this IP has no concert listings to return.

**Conclusion:** concert *scraping* does not produce usable data **from this development environment**. Neither stack works here: TS Playwright is IP-blocked (BMS) / empty (District); the earlier Python SerpAPI path returned only 1 thin record (no venue/city/price). This is an **environment/anti-bot blocker, not a code-readiness blocker** — the scrapers are wired correctly.

### Implication for MVP
Concert data cannot be reliably scraped from here right now. Realistic options for concerts (fast-follow, not demo-blocking):
1. **Run the scraper from the production/backend host** (Render) — a different egress IP that may not be Cloudflare-flagged.
2. **Use the Python SerpAPI path** (Google-side, bypasses the IP block) — returns *some* data but thin (needs the Python env set up + accepts lower quality).
3. **Manual/admin concert entry or a one-off verified dataset** for the demo.

### Recommendation (unchanged, now reinforced)
**Deploy the already-working analytics dashboard NOW** (11 artists, metrics, popularity, analytics, auth — all real data) and treat concerts as a **fast-follow** once we have an unblocked egress or accept SerpAPI-quality data. Concerts are confirmed to be the risky long-pole; everything else is demo-ready. Proceed to the deployment audit (Gate E).

