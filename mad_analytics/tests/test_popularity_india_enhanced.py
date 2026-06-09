"""Test enhanced popularity formula for Indian market.
V2: Fixed concert scoring — uses total tickets sold (volume), not just sell-through %.
Compares current production formula vs enhanced India formula.
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
    """Fetch artist data, platform metrics, trends, and concert data from DB."""
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("ERROR: DATABASE_URL not set")
        sys.exit(1)

    from sqlalchemy import create_engine, text as sql_text
    normalized = db_url.replace("postgres://", "postgresql://", 1) if db_url.startswith("postgres://") else db_url
    engine = create_engine(normalized)

    with engine.connect() as conn:
        artists = conn.execute(sql_text("""
            SELECT id, "artistName",
                   "instagramFollowers", "facebookFollowers",
                   "twitterFollowers", "spotifyMonthlyListeners",
                   "spotifyFollowers", "youtubeSubscribers",
                   "googleTrendsScore", popularity
            FROM artists WHERE active = true
        """)).mappings().all()

        ig_eng = conn.execute(sql_text("""
            SELECT DISTINCT ON ("artistId")
                "artistId", followers, likes, comments
            FROM platform_metrics
            WHERE platform = 'INSTAGRAM' AND followers > 0
            ORDER BY "artistId", "metricDate" DESC
        """)).mappings().all()

        yt_data = conn.execute(sql_text("""
            SELECT DISTINCT ON ("artistId")
                "artistId", streams, followers as yt_followers
            FROM platform_metrics
            WHERE platform = 'YOUTUBE' AND streams > 0
            ORDER BY "artistId", "metricDate" DESC
        """)).mappings().all()

        rog_data = conn.execute(sql_text("""
            SELECT "artistId", AVG("rogDaily") as avg_rog
            FROM platform_metrics
            WHERE "rogDaily" IS NOT NULL
              AND "metricDate" >= CURRENT_DATE - INTERVAL '90 days'
            GROUP BY "artistId"
        """)).mappings().all()

        # Concert data with volume + revenue (last 12 months)
        concert_data = conn.execute(sql_text("""
            SELECT "artistId",
                   COUNT(*) as total_concerts,
                   SUM("ticketsSold") as total_tickets_sold,
                   SUM(capacity) as total_capacity,
                   SUM("totalRevenue") as total_revenue
            FROM concerts
            WHERE "concertDate" >= CURRENT_DATE - INTERVAL '12 months'
              AND "ticketsSold" IS NOT NULL
              AND capacity IS NOT NULL
              AND capacity > 0
            GROUP BY "artistId"
        """)).mappings().all()

    engine.dispose()

    ig_map = {r["artistId"]: r for r in ig_eng}
    yt_map = {r["artistId"]: r for r in yt_data}
    rog_map = {r["artistId"]: float(r["avg_rog"]) for r in rog_data}
    concert_map = {r["artistId"]: r for r in concert_data}

    merged = {}
    for a in artists:
        aid = a["id"]
        name = a["artistName"]

        ig = ig_map.get(aid, {})
        ig_followers = int(ig.get("followers", 0) or int(a["instagramFollowers"] or 0))
        ig_likes = float(ig.get("likes", 0) or 0)
        ig_comments = float(ig.get("comments", 0) or 0)
        ig_er = round((ig_likes + ig_comments) / ig_followers * 100, 4) if ig_followers > 0 else 0.0

        yt = yt_map.get(aid, {})
        yt_streams = int(yt.get("streams", 0) or 0)
        yt_subs_val = int(yt.get("yt_followers", 0) or int(a["youtubeSubscribers"] or 0))

        # Concert metrics: volume (tickets sold) + efficiency (sell-through %)
        cd = concert_map.get(aid, {})
        total_tickets = int(cd.get("total_tickets_sold", 0) or 0)
        total_capacity = int(cd.get("total_capacity", 0) or 0)
        total_revenue = float(cd.get("total_revenue", 0) or 0)
        has_concerts = cd.get("total_concerts", 0) > 0
        if has_concerts and total_capacity > 0:
            sell_through = round((total_tickets / total_capacity) * 100, 2)
        else:
            sell_through = 0.0
        avg_capacity = round(total_capacity / cd["total_concerts"]) if has_concerts else 0

        merged[name] = {
            "id": aid,
            "name": name,
            "ig_followers": ig_followers,
            "ig_engagement_rate": ig_er,
            "fb_followers": int(a["facebookFollowers"] or 0),
            "yt_subscribers": yt_subs_val,
            "yt_streams": yt_streams,
            "sp_monthly_listeners": int(a["spotifyMonthlyListeners"] or 0),
            "sp_followers": int(a["spotifyFollowers"] or 0),
            "tw_followers": int(a["twitterFollowers"] or 0),
            "google_trends_score": float(a["googleTrendsScore"] or 0),
            "rog_daily": rog_map.get(aid, 0.0),
            "concert_tickets": total_tickets,
            "concert_revenue": total_revenue,
            "concert_avg_capacity": avg_capacity,
            "concert_sell_through": sell_through,
            "current_popularity": float(a["popularity"] or 0),
        }

    return merged


def log_normalize(val, max_val):
    """Log-scale normalize a value to 0-100."""
    if max_val <= 0 or val <= 0:
        return 0.0
    return min(100.0, math.log(1 + val) / math.log(1 + max_val) * 100)


def linear_normalize(val, max_val):
    """Linear normalize a value to 0-100."""
    if max_val <= 0 or val <= 0:
        return 0.0
    return min(100.0, (val / max_val) * 100)


def compute_scores(data):
    """Compute both current and enhanced formulas."""
    if not data:
        return data

    all_ig_f = [d["ig_followers"] for d in data.values()]
    all_fb_f = [d["fb_followers"] for d in data.values()]
    all_yt_s = [d["yt_subscribers"] for d in data.values()]
    all_yt_v = [d["yt_streams"] for d in data.values()]
    all_sp_l = [d["sp_monthly_listeners"] for d in data.values()]
    all_sp_f = [d["sp_followers"] for d in data.values()]
    all_tw_f = [d["tw_followers"] for d in data.values()]
    all_er   = [d["ig_engagement_rate"] for d in data.values()]
    all_gt   = [d["google_trends_score"] for d in data.values()]
    all_rog  = [d["rog_daily"] for d in data.values()]
    all_tkts = [d["concert_tickets"] for d in data.values()]
    all_rev  = [d["concert_revenue"] for d in data.values()]
    all_st   = [d["concert_sell_through"] for d in data.values()]

    max_ig_f = max(all_ig_f) or 1
    max_fb_f = max(all_fb_f) or 1
    max_yt_s = max(all_yt_s) or 1
    max_yt_v = max(all_yt_v) or 1
    max_sp_l = max(all_sp_l) or 1
    max_sp_f = max(all_sp_f) or 1
    max_tw_f = max(all_tw_f) or 1
    max_er   = max(all_er) or 0.01
    max_gt   = max(all_gt) or 1
    max_rog  = max(all_rog) or 0.01
    max_tkts = max(all_tkts) or 1
    max_rev  = max(all_rev) or 1
    max_st   = max(all_st) or 1

    for key, d in data.items():
        ig_f_s = log_normalize(d["ig_followers"], max_ig_f)
        fb_f_s = log_normalize(d["fb_followers"], max_fb_f)
        yt_s_s = log_normalize(d["yt_subscribers"], max_yt_s)
        yt_v_s = log_normalize(d["yt_streams"], max_yt_v)
        sp_l_s = log_normalize(d["sp_monthly_listeners"], max_sp_l)
        sp_f_s = log_normalize(d["sp_followers"], max_sp_f)
        tw_f_s = log_normalize(d["tw_followers"], max_tw_f)
        er_s   = log_normalize(d["ig_engagement_rate"], max_er)
        gt_s   = log_normalize(d["google_trends_score"], max_gt)
        rog_s  = log_normalize(d["rog_daily"], max_rog)
        tkts_s = log_normalize(d["concert_tickets"], max_tkts)
        rev_s  = log_normalize(d["concert_revenue"], max_rev)
        st_s   = linear_normalize(d["concert_sell_through"], max_st)

        # Concert score: blend of volume (tickets sold) + efficiency (sell-through)
        # Log scale for tickets captures diminishing returns of scale
        # Concert score: blend of volume (tickets sold) + efficiency (sell-through)
        # Fallback: artists with no concert data get a neutral 30 instead of 0
        if d["concert_tickets"] > 0:
            concert_s = tkts_s * 0.70 + st_s * 0.30
        else:
            concert_s = 30.0  # neutral default for missing data

        # -- CURRENT PRODUCTION FORMULA --
        current_base = (
            sp_l_s * 0.40 +
            yt_s_s * 0.25 +
            ig_f_s * 0.25 +
            fb_f_s * 0.10
        )
        current_pop = (
            current_base * 0.50 +
            gt_s * 0.25 +
            rog_s * 0.25
        )

        # -- ENHANCED INDIA FORMULA V3 --
        # Concert weight = highest (ticket sales = truest measure of popularity)
        # GT weight reduced: "Arijit Singh" is a generic name that inflates search
        # ER weight reduced: Arijit's 18% ER is anomalously high (data quality)
        # Diljit: #1 in concert volume (236K tix, 21 stadium shows), YT streams
        enhanced_base = (
            yt_v_s * 0.25 +
            sp_l_s * 0.20 +
            ig_f_s * 0.15 +
            yt_s_s * 0.10 +
            tw_f_s * 0.05 +
            fb_f_s * 0.05 +
            sp_f_s * 0.05
        )
        enhanced_pop = (
            enhanced_base * 0.30 +
            gt_s * 0.05 +
            rog_s * 0.10 +
            er_s * 0.05 +
            concert_s * 0.50
        )

        d["scores"] = {
            "ig_followers_norm": round(ig_f_s, 2),
            "fb_followers_norm": round(fb_f_s, 2),
            "yt_subscribers_norm": round(yt_s_s, 2),
            "yt_streams_norm": round(yt_v_s, 2),
            "sp_listeners_norm": round(sp_l_s, 2),
            "sp_followers_norm": round(sp_f_s, 2),
            "tw_followers_norm": round(tw_f_s, 2),
            "engagement_rate_norm": round(er_s, 2),
            "google_trends_norm": round(gt_s, 2),
            "rog_norm": round(rog_s, 2),
            "tickets_norm": round(tkts_s, 2),
            "revenue_norm": round(rev_s, 2),
            "sell_through_norm": round(st_s, 2),
            "concert_score": round(concert_s, 2),
            "current_popularity": round(current_pop, 2),
            "enhanced_popularity": round(enhanced_pop, 2),
        }

    return data


def print_results(data):
    """Print side-by-side comparison of current vs enhanced."""
    sorted_current = sorted(
        data.items(),
        key=lambda x: x[1]["scores"]["current_popularity"],
        reverse=True
    )
    sorted_enhanced = sorted(
        data.items(),
        key=lambda x: x[1]["scores"]["enhanced_popularity"],
        reverse=True
    )

    print("=" * 180)
    print("INDIAN ARTIST POPULARITY - CURRENT vs ENHANCED FORMULA V3")
    print("=" * 180)

    current_rank = {k: i+1 for i, (k, _) in enumerate(sorted_current)}
    enhanced_rank = {k: i+1 for i, (k, _) in enumerate(sorted_enhanced)}

    header = (f"{'Rank Chg':<10} {'Artist':<22} {'Current':>8} {'Enhanced':>10} {'Diff':>6} "
              f"{'IG Foll':>10} {'ER%':>6} {'YT Strm':>10} {'SP List':>10} "
              f"{'Tickets':>10} {'Rev(M)':>10} {'SellThru':>7} {'Concert':>7}")
    print(f"\n{header}")
    print("-" * 180)

    for key, d in sorted_enhanced:
        s = d["scores"]
        cr = current_rank.get(key, "-")
        er_rank = enhanced_rank.get(key, "-")
        rank_chg = f"{cr}>{er_rank}" if cr != er_rank else f"  {cr}  "
        delta = s["enhanced_popularity"] - s["current_popularity"]
        delta_str = f"+{delta:.1f}" if delta > 0 else f"{delta:.1f}"
        rev_m = d["concert_revenue"] / 1_000_000 if d["concert_revenue"] else 0

        print(
            f"{rank_chg:<10} {d['name']:<22} "
            f"{s['current_popularity']:>8.2f} {s['enhanced_popularity']:>9.2f} {delta_str:>6} "
            f"{d['ig_followers']:>10,} {d['ig_engagement_rate']:>5.3f}% "
            f"{d['yt_streams']:>10,} {d['sp_monthly_listeners']:>10,} "
            f"{d['concert_tickets']:>10,} {rev_m:>9.1f} {d['concert_sell_through']:>6.2f}% "
            f"{s['concert_score']:>6.2f}"
        )

    print("\n" + "=" * 180)
    print("FORMULA BREAKDOWN")
    print("=" * 180)
    print("""
CURRENT FORMULA:
  Popularity = Base(50%) + Google Trends(25%) + RoG(25%)
  Base = Spotify(40%) + YouTube Subs(25%) + Instagram(25%) + Facebook(10%)

ENHANCED INDIA FORMULA V3:
  Popularity = Enhanced Base(30%) + Concert Score(50%)
               + Google Trends(5%) + RoG(10%) + Instagram ER(5%)

  Enhanced Base = YouTube Streams(25%) + Spotify Listeners(20%)
                  + Instagram Followers(15%) + YouTube Subs(10%)
                  + Twitter(5%) + Facebook(5%) + Spotify Followers(5%)

  Concert Score = Ticket Volume(70%) + Sell-Through Rate(30%)
                  - Ticket volume uses log scale (diminishing returns)

KEY CHANGES:
  Concert weight increased to 50% (ticket sales = truest popularity signal)
  GT weight reduced to 5% ("Arijit Singh" is a common name inflating search)
  ER weight reduced to 5% (Arijit's 18% ER is suspiciously high)
  Diljit: 236K tickets across 21 stadium shows -> properly rewarded as #1
""")

    print("=" * 180)
    print("TOP 5 DETAIL - ENHANCED FORMULA V3")
    print("=" * 180)

    for rank, (key, d) in enumerate(sorted_enhanced[:5], 1):
        s = d["scores"]
        print(f"\n  #{rank} {d['name']}")

        eb = (s["yt_streams_norm"] * 0.25 + s["sp_listeners_norm"] * 0.20 +
              s["ig_followers_norm"] * 0.15 + s["yt_subscribers_norm"] * 0.10 +
              s["tw_followers_norm"] * 0.05 + s["fb_followers_norm"] * 0.05 +
              s["sp_followers_norm"] * 0.05)
        concert_s = s["tickets_norm"] * 0.70 + s["sell_through_norm"] * 0.30

        eb_contrib = eb * 0.30
        gt_contrib = s["google_trends_norm"] * 0.05
        rog_contrib = s["rog_norm"] * 0.10
        er_contrib = s["engagement_rate_norm"] * 0.05
        cs_contrib = concert_s * 0.50

        print(f"    Current: {s['current_popularity']:.2f} -> Enhanced: {s['enhanced_popularity']:.2f}")
        print(f"    Base(30%): {eb:.2f} x 0.30 = {eb_contrib:.2f}")
        print(f"      YT Strm({s['yt_streams_norm']:.1f}x0.25) + SP List({s['sp_listeners_norm']:.1f}x0.20)")
        print(f"      + IG Foll({s['ig_followers_norm']:.1f}x0.15) + YT Subs({s['yt_subscribers_norm']:.1f}x0.10)")
        print(f"      + TW Foll({s['tw_followers_norm']:.1f}x0.05) + FB({s['fb_followers_norm']:.1f}x0.05) + SP Foll({s['sp_followers_norm']:.1f}x0.05)")
        print(f"    Concert(50%): {concert_s:.2f} x 0.50 = {cs_contrib:.2f}")
        print(f"      Tickets({d['concert_tickets']:,}, norm={s['tickets_norm']:.1f}) x 0.70 + SellThru({d['concert_sell_through']:.1f}%, norm={s['sell_through_norm']:.1f}) x 0.30")
        print(f"    GT(5%): {s['google_trends_norm']:.1f} x 0.05 = {gt_contrib:.2f}")
        print(f"    RoG(10%): {s['rog_norm']:.1f} x 0.10 = {rog_contrib:.2f}")
        print(f"    IG ER(5%): {s['engagement_rate_norm']:.1f} x 0.05 = {er_contrib:.2f}")
        print(f"    FINAL = {eb_contrib + gt_contrib + rog_contrib + er_contrib + cs_contrib:.2f}")

    print("\n" + "=" * 180)
    print(f"Artists scored: {len(data)}")
    print("=" * 180)


if __name__ == "__main__":
    print("=" * 180)
    print("ENHANCED POPULARITY FORMULA V3 - INDIA MARKET")
    print("=" * 180)
    print("\nFetching data from database...")

    data = fetch_all_data()
    print(f"Found {len(data)} active artists")

    data = compute_scores(data)
    print_results(data)
