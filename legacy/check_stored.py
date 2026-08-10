import json, urllib.request
with urllib.request.urlopen("http://localhost:3001/api/v1/artists") as r:
    data = json.loads(r.read())["data"]["artists"]
artists = sorted(data, key=lambda x: float(x.get("googleTrendsScore") or 0), reverse=True)
for a in artists:
    print(f'{a["artistName"]:25s} trends={a.get("googleTrendsScore","N/A")}  pop={a.get("popularity","N/A")}')
