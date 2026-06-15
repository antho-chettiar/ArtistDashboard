"""Check what YOUTUBE streams column actually stores."""
import sys; sys.path.insert(0, '.')
import os
os.environ['DATABASE_URL'] = 'postgresql://97c05ce56e7b0754a29b65ed14a577a442e560cbc9422c455e7a1ac39d95337a:sk_cgYqqfMkg36x34oe0P6a6@db.prisma.io:5432/postgres?sslmode=require'

from sqlalchemy import create_engine, text
e = create_engine(os.environ['DATABASE_URL'])

with e.connect() as c:
    r = c.execute(text("""
        SELECT a."artistName", pm.streams, pm.followers, pm."metricDate",
               pm."rawSnapshot"::text as snapshot
        FROM platform_metrics pm
        JOIN artists a ON a.id = pm."artistId"
        WHERE pm.platform = 'YOUTUBE' AND pm.streams > 0
        ORDER BY a."artistName", pm."metricDate" DESC
    """)).all()
    for x in r:
        print(f"{x.artistName:<25} streams={x.streams:<15} subs={x.followers:<10} date={x.metricDate}")
        if x.snapshot and len(x.snapshot) > 20:
            try:
                import json
                snap = json.loads(x.snapshot)
                print(f"  snapshot keys: {list(snap.keys())}")
                if 'total_views' in snap:
                    print(f"  total_views={snap['total_views']}")
                if 'latest_videos' in snap and snap['latest_videos']:
                    print(f"  latest_video_views={[v.get('views', 0) for v in snap['latest_videos'][:3]]}")
            except:
                print(f"  raw: {x.snapshot[:200]}")
