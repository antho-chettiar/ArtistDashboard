"""Check Taylor Swift and Drake data."""
import sys; sys.path.insert(0, '.')
import os
os.environ['DATABASE_URL'] = 'postgresql://97c05ce56e7b0754a29b65ed14a577a442e560cbc9422c455e7a1ac39d95337a:sk_cgYqqfMkg36x34oe0P6a6@db.prisma.io:5432/postgres?sslmode=require'

from sqlalchemy import create_engine, text
e = create_engine(os.environ['DATABASE_URL'])

with e.connect() as c:
    print('=== ARTISTS matching Taylor/Drake ===')
    r = c.execute(text("SELECT id, \"artistName\" FROM artists WHERE \"artistName\" ILIKE '%taylor%' OR \"artistName\" ILIKE '%drake%'")).all()
    for x in r: print(f"  ID={x[0]}, Name={x[1]}")
    ids = [x[0] for x in r]

    print('\n=== CONCERTS table columns ===')
    r0 = c.execute(text("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'concerts'")).all()
    for x in r0: print(f"  {x}")

    print('\n=== CONCERTS (last 12mo) ===')
    r2 = c.execute(text("""
        SELECT "artistId", "artistName", COUNT(*) as shows,
               SUM("ticketsSold") as tix, SUM(capacity) as cap,
               MIN("concertDate"), MAX("concertDate")
        FROM concerts
        WHERE "concertDate" >= NOW() - INTERVAL '12 months'
          AND "artistId" = ANY(:ids)
        GROUP BY "artistId", "artistName"
    """), {"ids": ids}).all()
    if r2:
        for x in r2: print(f"  {x}")
    else:
        print("  No concerts in last 12 months")

    print('\n=== platform_metrics columns ===')
    r0b = c.execute(text("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'platform_metrics'")).all()
    for x in r0b: print(f"  {x}")

    print('\n=== YOUTUBE METRICS ===')
    r3 = c.execute(text("""
        SELECT "artistId", "metricDate", streams, followers
        FROM platform_metrics
        WHERE platform = 'YOUTUBE'
          AND "artistId" = ANY(:ids)
        ORDER BY "metricDate" DESC LIMIT 20
    """), {"ids": ids}).all()
    for x in r3: print(f"  {x}")

    print('\n=== SPOTIFY LISTENERS (artists table) ===')
    r4 = c.execute(text("""
        SELECT id, "artistName", "spotifyMonthlyListeners", "spotifyFollowers"
        FROM artists WHERE id = ANY(:ids)
    """), {"ids": ids}).all()
    for x in r4: print(f"  {x}")

    print('\n=== ALL platform_metrics rows ===')
    r5 = c.execute(text("""
        SELECT platform, COUNT(*), MAX("metricDate"), MAX(streams), MAX(followers)
        FROM platform_metrics
        WHERE "artistId" = ANY(:ids)
        GROUP BY platform
        ORDER BY platform
    """), {"ids": ids}).all()
    for x in r5: print(f"  {x}")

    print('\n=== Instagram latest ===')
    r6 = c.execute(text("""
        SELECT DISTINCT ON ("artistId") "artistId", "metricDate", followers, likes, comments
        FROM platform_metrics
        WHERE platform = 'INSTAGRAM' AND "artistId" = ANY(:ids)
        ORDER BY "artistId", "metricDate" DESC
    """), {"ids": ids}).all()
    for x in r6: print(f"  {x}")

    print('\n=== YT subs from artists table ===')
    r7 = c.execute(text("""
        SELECT id, "artistName", "youtubeSubscribers"
        FROM artists WHERE id = ANY(:ids)
    """), {"ids": ids}).all()
    for x in r7: print(f"  {x}")

    print('\n=== All concerts for Taylor (all time) ===')
    r8 = c.execute(text("""
        SELECT "artistName", "concertDate", city, country, "ticketsSold", capacity
        FROM concerts
        WHERE "artistId" = 'a19b191f-8575-4f19-a1f1-324976fad630'
        ORDER BY "concertDate" DESC LIMIT 20
    """)).all()
    for x in r8: print(f"  {x}")

    print('\n=== All concerts for Drake (all time) ===')
    r9 = c.execute(text("""
        SELECT "artistName", "concertDate", city, country, "ticketsSold", capacity
        FROM concerts
        WHERE "artistId" = '0635689e-6ebf-4ae8-8335-db014e6e156f'
        ORDER BY "concertDate" DESC LIMIT 20
    """)).all()
    for x in r9: print(f"  {x}")
