"""Check youtubeSubscribers and find channel IDs for missing artists."""
import sys; sys.path.insert(0, '.')
import os
os.environ['DATABASE_URL'] = 'postgresql://97c05ce56e7b0754a29b65ed14a577a442e560cbc9422c455e7a1ac39d95337a:sk_cgYqqfMkg36x34oe0P6a6@db.prisma.io:5432/postgres?sslmode=require'

from sqlalchemy import create_engine, text
e = create_engine(os.environ['DATABASE_URL'])

with e.connect() as c:
    r = c.execute(text("""
        SELECT "artistName", "youtubeSubscribers", id
        FROM artists WHERE active = true
        ORDER BY "artistName"
    """)).all()
    for x in r:
        print(f"{x.artistName:<25} subs={x.youtubeSubscribers:<12} id={x.id[:8]}...")
