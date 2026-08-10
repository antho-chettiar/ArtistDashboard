from pytrends.request import TrendReq

pytrends = TrendReq(
    hl='en-IN',
    tz=330
)

pytrends.build_payload(
    ['Arijit Singh'],
    timeframe='today 3-m',
    geo='IN'
)

data = pytrends.interest_over_time()
print(data.head())

# Get today's trending searches in the IN
trending_searches_df = pytrends.trending_searches(pn='IN')
# Display trending searches
print(trending_searches_df) 