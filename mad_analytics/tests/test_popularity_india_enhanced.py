"""Test multiple popularity formula scenarios for all artists.
Shows 4 scenarios side-by-side so the client can pick.
"""
from __future__ import annotations
import logging
import math
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")

env_path = Path(__file__).parent.parent.parent / "backend" / ".env"
if env_path.exists():
    with open(env_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and not os.environ.get(key):
                    os.environ[key] = value


def fetch_all_data():
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("ERROR: DATABASE_URL not set"); sys.exit(1)

    from sqlalchemy import create_engine, text as sql_text
    normalized = db_url.replace("postgres://", "postgresql://", 1) if db_url.startswith("postgres://") else db_url
    engine = create_engine(normalized)

    with engine.connect() as conn:
        artists = conn.execute(sql_text("""
            SELECT id, "artistName", "instagramFollowers", "facebookFollowers",
                   "twitterFollowers", "spotifyMonthlyListeners", "spotifyFollowers",
                   "youtubeSubscribers", "googleTrendsScore", popularity
            FROM artists WHERE active = true
        """)).mappings().all()

        ig_eng = conn.execute(sql_text("""
            SELECT DISTINCT ON ("artistId") "artistId", followers, likes, comments
            FROM platform_metrics WHERE platform = 'INSTAGRAM' AND followers > 0
            ORDER BY "artistId", "metricDate" DESC
        """)).mappings().all()

        yt_data = conn.execute(sql_text("""
            SELECT DISTINCT ON ("artistId") "artistId", streams, followers as yt_followers
            FROM platform_metrics WHERE platform = 'YOUTUBE' AND streams > 0
            ORDER BY "artistId", "metricDate" DESC
        """)).mappings().all()

        rog_data = conn.execute(sql_text("""
            SELECT "artistId", AVG("rogDaily") as avg_rog FROM platform_metrics
            WHERE "rogDaily" IS NOT NULL AND "metricDate" >= CURRENT_DATE - INTERVAL '90 days'
            GROUP BY "artistId"
        """)).mappings().all()

        concert_data = conn.execute(sql_text("""
            SELECT "artistId", COUNT(*) as total_concerts,
                   SUM("ticketsSold") as total_tickets_sold,
                   SUM(capacity) as total_capacity, SUM("totalRevenue") as total_revenue
            FROM concerts
            WHERE "concertDate" >= CURRENT_DATE - INTERVAL '12 months'
              AND "ticketsSold" IS NOT NULL AND capacity IS NOT NULL AND capacity > 0
            GROUP BY "artistId"
        """)).mappings().all()

    engine.dispose()

    ig_map = {r["artistId"]: r for r in ig_eng}
    yt_map = {r["artistId"]: r for r in yt_data}
    rog_map = {r["artistId"]: float(r["avg_rog"]) for r in rog_data}
    concert_map = {r["artistId"]: r for r in concert_data}

    merged = {}
    for a in artists:
        aid = a["id"]; name = a["artistName"]

        ig = ig_map.get(aid, {})
        ig_f = int(ig.get("followers", 0) or int(a["instagramFollowers"] or 0))
        ig_l = float(ig.get("likes", 0) or 0)
        ig_c = float(ig.get("comments", 0) or 0)
        ig_er = round((ig_l + ig_c) / ig_f * 100, 4) if ig_f > 0 else 0.0

        yt = yt_map.get(aid, {})
        yt_st = int(yt.get("streams", 0) or 0)
        yt_subs = int(yt.get("yt_followers", 0) or int(a["youtubeSubscribers"] or 0))
        # Fallback: when no YT platform_metrics exist, use subscribers as proxy
        # (scraper will populate real total_views into streams column later)
        if yt_st == 0 and yt_subs > 0:
            yt_st = yt_subs * 200  # rough views-per-subscriber ratio for established channels

        cd = concert_map.get(aid, {})
        tix = int(cd.get("total_tickets_sold", 0) or 0)
        cap = int(cd.get("total_capacity", 0) or 0)
        rev = float(cd.get("total_revenue", 0) or 0)
        has_c = cd.get("total_concerts", 0) > 0
        st = round((tix / cap) * 100, 2) if has_c and cap > 0 else 0.0
        avg_cap = round(cap / cd["total_concerts"]) if has_c else 0
        num_shows = cd.get("total_concerts", 0) if has_c else 0

        merged[name] = {
            "name": name, "id": aid, "ig_followers": ig_f, "ig_er": ig_er,
            "fb_followers": int(a["facebookFollowers"] or 0),
            "yt_subs": yt_subs, "yt_streams": yt_st,
            "sp_listeners": int(a["spotifyMonthlyListeners"] or 0),
            "sp_followers": int(a["spotifyFollowers"] or 0),
            "tw_followers": int(a["twitterFollowers"] or 0),
            "gt_score": float(a["googleTrendsScore"] or 0),
            "rog_daily": rog_map.get(aid, 0.0),
            "tickets": tix, "revenue": rev, "sell_through": st,
            "num_shows": num_shows, "avg_capacity": avg_cap,
            "current_pop": float(a["popularity"] or 0),
        }

    return merged


def min_max(val, mn, mx):
    """Min-max normalization across all artists (see reference doc §2)."""
    if mx <= mn or val <= mn: return 0.0
    return min(100.0, (val - mn) / (mx - mn) * 100)

def log_norm(val, mx):
    if mx <= 0 or val <= 0: return 0.0
    return min(100.0, math.log(1 + val) / math.log(1 + mx) * 100)


def compute_scenarios(data):
    if not data: return data

    # --- Min-Max normalization (as specified in reference doc) ---
    all_ig = [d["ig_followers"] for d in data.values()]
    all_fb = [d["fb_followers"] for d in data.values()]
    all_yt_s = [d["yt_subs"] for d in data.values()]
    all_sp = [d["sp_listeners"] for d in data.values()]
    all_gt = [d["gt_score"] for d in data.values()]
    all_rog = [d["rog_daily"] for d in data.values()]

    mn_ig, mx_ig = min(all_ig), max(all_ig)
    mn_fb, mx_fb = min(all_fb), max(all_fb)
    mn_ys, mx_ys = min(all_yt_s), max(all_yt_s)
    mn_sp, mx_sp = min(all_sp), max(all_sp)
    mn_gt, mx_gt = min(all_gt), max(all_gt)
    mn_rog, mx_rog = min(all_rog), max(all_rog)

    # --- Log normalization (better for outlier-heavy data) ---
    m_ig = max(all_ig) or 1; m_fb = max(all_fb) or 1; m_ys = max(all_yt_s) or 1
    m_sp = max(all_sp) or 1; m_gt = max(all_gt) or 1; m_rog = max(all_rog) or 0.01

    for d in data.values():
        # === Min-Max scores ===
        ig_mm = min_max(d["ig_followers"], mn_ig, mx_ig)
        fb_mm = min_max(d["fb_followers"], mn_fb, mx_fb)
        yt_s_mm = min_max(d["yt_subs"], mn_ys, mx_ys)
        sp_mm = min_max(d["sp_listeners"], mn_sp, mx_sp)
        gt_mm = min_max(d["gt_score"], mn_gt, mx_gt)
        rog_mm = min_max(d["rog_daily"], mn_rog, mx_rog)

        # === Log scores ===
        ig_ln = log_norm(d["ig_followers"], m_ig)
        fb_ln = log_norm(d["fb_followers"], m_fb)
        yt_s_ln = log_norm(d["yt_subs"], m_ys)
        sp_ln = log_norm(d["sp_listeners"], m_sp)
        gt_ln = log_norm(d["gt_score"], m_gt)
        rog_ln = log_norm(d["rog_daily"], m_rog)

        # === Platform Size Score (Section 2 detail) ===
        # Spotify(40%) + YTSubs(25%) + IG(25%) + FB(10%)
        plat_mm = sp_mm * 0.40 + yt_s_mm * 0.25 + ig_mm * 0.25 + fb_mm * 0.10
        plat_ln = sp_ln * 0.40 + yt_s_ln * 0.25 + ig_ln * 0.25 + fb_ln * 0.10

        # === Current / Base Entropy (as used in reference doc) ===
        current_mm = plat_mm * 0.50 + gt_mm * 0.25 + rog_mm * 0.25
        current_ln = plat_ln * 0.50 + gt_ln * 0.25 + rog_ln * 0.25

        # === DEMAND SCORE (Section 2) ===
        # Platform(35%) + Momentum(35%) + GT(20%) + City(10%)
        demand_mm = plat_mm * 0.35 + rog_mm * 0.35 + gt_mm * 0.20 + 10.0  # city_affinity = 10 (neutral)
        demand_ln = plat_ln * 0.35 + rog_ln * 0.35 + gt_ln * 0.20 + 10.0

        # === POPULARITY SCORE (Section 7) ===
        # BaseEntropy(60%) + Momentum(20%) + GT(20%)
        pop_mm = current_mm * 0.60 + rog_mm * 0.20 + gt_mm * 0.20
        pop_ln = current_ln * 0.60 + rog_ln * 0.20 + gt_ln * 0.20

        # === VARIANT: Balanced ===
        # BaseEntropy(50%) + Momentum(25%) + GT(25%)
        bal_mm = current_mm * 0.50 + rog_mm * 0.25 + gt_mm * 0.25
        bal_ln = current_ln * 0.50 + rog_ln * 0.25 + gt_ln * 0.25

        # === VARIANT: Stream-weighted ===
        # BaseEntropy(40%) + Momentum(30%) + GT(30%)
        str_mm = current_mm * 0.40 + rog_mm * 0.30 + gt_mm * 0.30
        str_ln = current_ln * 0.40 + rog_ln * 0.30 + gt_ln * 0.30

        d["scores"] = {
            "current_mm": round(current_mm, 2),
            "current_ln": round(current_ln, 2),
            "plat_mm": round(plat_mm, 2),
            "plat_ln": round(plat_ln, 2),
            "demand_mm": round(demand_mm, 2),
            "demand_ln": round(demand_ln, 2),
            "pop_mm": round(pop_mm, 2),
            "pop_ln": round(pop_ln, 2),
            "bal_mm": round(bal_mm, 2),
            "bal_ln": round(bal_ln, 2),
            "str_mm": round(str_mm, 2),
            "str_ln": round(str_ln, 2),
            "gt_mm": round(gt_mm, 2),
            "gt_ln": round(gt_ln, 2),
            "rog_mm": round(rog_mm, 2),
            "rog_ln": round(rog_ln, 2),
        }

    return data


def print_results(data):
    print("=" * 190)
    print("PREDICTION REFERENCE FORMULAS — All Artists (No Concerts)")
    print("=" * 190)

    scenarios = [
        ("pop_mm",   "Popularity (§7) [MM]"),
        ("pop_ln",   "Popularity (§7) [LOG]"),
        ("demand_mm", "Demand (§2) [MM]"),
        ("demand_ln", "Demand (§2) [LOG]"),
        ("plat_mm",  "Platform [MM]"),
        ("plat_ln",  "Platform [LOG]"),
        ("bal_mm",   "Balanced [MM]"),
        ("bal_ln",   "Balanced [LOG]"),
        ("str_mm",   "Stream [MM]"),
        ("str_ln",   "Stream [LOG]"),
    ]

    for s, lbl in scenarios:
        sorted_by_s = sorted(data.items(), key=lambda x: x[1]["scores"][s], reverse=True)
        print(f"\n--- Ranking by {lbl} ---")
        header = (f"{'Rank':<5} {'Artist':<22} {'Score':>8} {'IG Foll':>10} {'YT Subs':>10} "
                  f"{'SP List':>10} {'GT':>6} {'RoG':>6}")
        print(header)
        print("-" * 80)
        for rank, (key, d) in enumerate(sorted_by_s, 1):
            sc = d["scores"]
            print(
                f"{rank:<5} {d['name']:<22} {sc[s]:>8.2f} "
                f"{d['ig_followers']:>10,} {d['yt_subs']:>10,} {d['sp_listeners']:>10,} "
                f"{sc['gt_ln' if 'LN' in lbl.upper() else 'gt_mm']:>5.1f} "
                f"{sc['rog_ln' if 'LN' in lbl.upper() else 'rog_mm']:>5.1f}"
            )

    # === SIDE-BY-SIDE: Min-Max (reference doc) ===
    print("\n" + "=" * 130)
    print("SIDE-BY-SIDE — MIN-MAX (as specified in doc)")
    print("=" * 130)
    print(f"{'Artist':<22} {'Current':>8} {'Popularity':>10} {'Demand':>8} {'Platform':>9} {'Balanced':>9} {'Stream':>8}")
    print("-" * 77)
    for key, d in sorted(data.items(), key=lambda x: x[1]["scores"]["current_mm"], reverse=True):
        sc = d["scores"]
        print(f"{d['name']:<22} {sc['current_mm']:>8.1f} {sc['pop_mm']:>10.1f} {sc['demand_mm']:>8.1f} {sc['plat_mm']:>9.1f} {sc['bal_mm']:>9.1f} {sc['str_mm']:>8.1f}")

    # === SIDE-BY-SIDE: Log (better for outliers) ===
    print("\n" + "=" * 130)
    print("SIDE-BY-SIDE — LOG (better for outlier-heavy data)")
    print("=" * 130)
    print(f"{'Artist':<22} {'Current':>8} {'Popularity':>10} {'Demand':>8} {'Platform':>9} {'Balanced':>9} {'Stream':>8}")
    print("-" * 77)
    for key, d in sorted(data.items(), key=lambda x: x[1]["scores"]["current_ln"], reverse=True):
        sc = d["scores"]
        print(f"{d['name']:<22} {sc['current_ln']:>8.1f} {sc['pop_ln']:>10.1f} {sc['demand_ln']:>8.1f} {sc['plat_ln']:>9.1f} {sc['bal_ln']:>9.1f} {sc['str_ln']:>8.1f}")

    print("\n" + "=" * 130)
    print("FORMULA DEFINITIONS (from Prediction_Formula_Reference)")
    print("=" * 130)
    print("""
All use: Spotify(40%) + YTSubs(25%) + IG(25%) + FB(10%) as Platform score

Current (Base Entropy) = Platform(50%) + GT(25%) + RoG(25%)

Popularity (§7) = Current x 0.60 + RoG x 0.20 + GT x 0.20

Demand (§2)     = Platform x 0.35 + RoG x 0.35 + GT x 0.20 + 10(City)
  city_affinity fixed at 10 (neutral) for artist-level

Balanced        = Current x 0.50 + RoG x 0.25 + GT x 0.25

Stream          = Current x 0.40 + RoG x 0.30 + GT x 0.30

[MM] = min-max normalization (as specified in doc)
[LOG] = log normalization (better for Taylor/Drake outliers)
""")
    print("=" * 190)


def highlight_7(data):
    """Print only the 7 user artists side by side."""
    target = {"A R Rahman", "Arijit Singh", "Diljit Dosanjh", "Drake", "Shreya Ghoshal", "Sonu Nigam", "Taylor swift",
              "Vishal Mishra", "Badshah"}
    key_map = {
        "taylor": "Taylor swift", "arijit": "Arijit Singh", "drake": "Drake",
        "diljit": "Diljit Dosanjh", "shreya": "Shreya Ghoshal", "sonu": "Sonu Nigam",
        "vishal": "Vishal Mishra", "badshah": "Badshah", "rahman": "A R Rahman"
    }
    print("\n" + "=" * 150)
    print("YOUR 7 ARTISTS — All 10 Scenarios (Log + Min-Max)")
    print("=" * 150)
    print(f"{'Artist':<22} {'Cur[L]':>7} {'Pop[L]':>7} {'Dem[L]':>7} {'Plat[L]':>7} {'Bal[L]':>7} {'Str[L]':>7} |"
          f"{'Cur[M]':>7} {'Pop[M]':>7} {'Dem[M]':>7} {'Plat[M]':>7} {'Bal[M]':>7} {'Str[M]':>7}")
    print("-" * 150)
    order = ["taylor", "drake", "arijit", "diljit", "shreya", "badshah", "rahman", "sonu", "vishal"]
    for k in order:
        n = key_map[k]
        if n not in data: continue
        d = data[n]
        sc = d["scores"]
        print(f"{d['name']:<22} "
              f"{sc['current_ln']:>7.1f} {sc['pop_ln']:>7.1f} {sc['demand_ln']:>7.1f} {sc['plat_ln']:>7.1f} {sc['bal_ln']:>7.1f} {sc['str_ln']:>7.1f} |"
              f"{sc['current_mm']:>7.1f} {sc['pop_mm']:>7.1f} {sc['demand_mm']:>7.1f} {sc['plat_mm']:>7.1f} {sc['bal_mm']:>7.1f} {sc['str_mm']:>7.1f}")


if __name__ == "__main__":
    print("=" * 185)
    print("MULTI-SCENARIO POPULARITY COMPARISON")
    print("=" * 185)
    print("\nFetching data...")

    data = fetch_all_data()
    print(f"Found {len(data)} artists")

    data = compute_scenarios(data)
    print_results(data)
    highlight_7(data)
