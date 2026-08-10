from pytrends.request import TrendReq
import pandas as pd
import matplotlib.pyplot as plt


# Initialize a Google Trends session
pytrends = TrendReq(hl='en-IN', tz=330)

# Define search terms
keywords = ["Diljit Dosanjh Concerts", "Shreya Ghoshal Concerts", "Arijit Singh Concerts"]
# Build payload
pytrends.build_payload(kw_list=keywords, timeframe='today 12-m', geo='IN')

# Fetch interest over time
interest_over_time_df = pytrends.interest_over_time()
# Display the data
print(interest_over_time_df.head())

# Plotting the interest over time
interest_over_time_df.plot(figsize=(10, 6))
plt.title('Google Trends Over Time')
plt.xlabel('Date')
plt.ylabel('Interest Level')
plt.grid()
plt.show()


related_queries = pytrends.related_queries()
# Display related queries for each term
for key, value in related_queries.items():
    print(f"Related queries for {key}:")
    print(value['top'])

# Fetch interest by region
interest_by_region_df = pytrends.interest_by_region(resolution='CITY')
# Display interest by region
print(interest_by_region_df.head())

# Plotting a bar chart for top cities
interest_by_region_df.sort_values(by='Arijit Singh Concerts', ascending=False).head(10).plot(kind='bar', figsize=(10, 6))
plt.title('Top 10 Cities Interested in Concerts')
plt.xlabel('City')
plt.ylabel('Interest Level')
plt.grid()
plt.show()

# Building payload with a category filter (e.g., 'Computer & Electronics')
pytrends.build_payload(kw_list=["Python"], cat=35, timeframe='today 3-m', geo='IN')
# Extracting and exporting data to a CSV file
interest_over_time = pytrends.interest_over_time()
interest_over_time.to_csv('google_trends_data.csv')


# Calculate average interest for each keyword
average_interest = interest_over_time_df.mean()
print(average_interest)


# Get today's trending searches in the IN
trending_searches_df = pytrends.trending_searches(pn='IN')
# Display trending searches
print(trending_searches_df)

# For Music
# Fetch realtime trends for India, filtered by entertainment/music ('m')
realtime_df = pytrends.realtime_trending_searches(pn='IN', cat='m')
# Display the trending topics
print(realtime_df[['title', 'entityNames']])

# Get real-time trending searches
real_time_trends = pytrends.realtime_trending_searches(pn='IN')
# Display real-time trends
print(real_time_trends.head())

# Get suggestions for related keywords
suggestions = pytrends.suggestions(keyword='Concerts')
# Display suggestions
print(suggestions)


import schedule
import time
# Define a function to scrape and save Google Trends data
def scrape_google_trends():
    pytrends.build_payload(kw_list=["Python Programming"], timeframe='now 7-d')
    data = pytrends.interest_over_time()
    data.to_csv('weekly_google_trends_data.csv')

# Schedule the job to run every Monday at 8 am
schedule.every().wednesday.at("18:00").do(scrape_google_trends)


from time import sleep
pytrends = TrendReq(hl='en-US', tz=360)
sleep(60) # Pauses for a minute between requests