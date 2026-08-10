#!/usr/bin/env python3
"""
Simple test to verify the ML model works with real data from the database
"""

import json
import subprocess
import sys
import os

def ml_predict(input_data):
    """Call the ML processor and return the result"""
    processor_path = os.path.join(os.path.dirname(__file__), '..', 'ml_engine', 'processor.py')

    result = subprocess.run([
        sys.executable,
        processor_path,
        json.dumps(input_data)
    ],
    capture_output=True,
    text=True,
    timeout=10
    )

    if result.returncode != 0:
        raise Exception(f"ML processor failed: {result.stderr}")

    return json.loads(result.stdout.strip())

def test_with_sample_data():
    print("Testing ML Model with Sample Data")
    print("=" * 40)

    # Test case 1: Based on Javed Ali data from database
    test1 = {
        "artist_popularity": 75,
        "artist_city_popularity": 60,
        "venue_capacity": 3500,
        "city": "Plano",
        "country": "United States"
    }

    try:
        result1 = ml_predict(test1)
        revenue_cr1 = result1['total_revenue'] / 10000000
        print(f"Test 1 - Javed Ali (Plano, US):")
        print(f"  Revenue: INR {result1['total_revenue']:,.2f} ({revenue_cr1:.2f} crores)")
        print(f"  Tickets Sold: {result1['tickets_sold']:,}")
        print(f"  Avg Ticket Price: INR {result1['avg_ticket_price']:,.2f}")
        print()
    except Exception as e:
        print(f"Test 1 failed: {e}")

    # Test case 2: High revenue scenario
    test2 = {
        "artist_popularity": 90,
        "artist_city_popularity": 85,
        "venue_capacity": 50000,
        "city": "Mumbai",
        "country": "India"
    }

    try:
        result2 = ml_predict(test2)
        revenue_cr2 = result2['total_revenue'] / 10000000
        print(f"Test 2 - Major Artist (Mumbai, IN):")
        print(f"  Revenue: INR {result2['total_revenue']:,.2f} ({revenue_cr2:.2f} crores)")
        print(f"  Tickets Sold: {result2['tickets_sold']:,}")
        print(f"  Avg Ticket Price: INR {result2['avg_ticket_price']:,.2f}")
        print()
    except Exception as e:
        print(f"Test 2 failed: {e}")

    # Test case 3: International currency conversion
    test3 = {
        "artist_popularity": 80,
        "artist_city_popularity": 70,
        "venue_capacity": 15000,
        "city": "London",
        "country": "United Kingdom"
    }

    try:
        result3 = ml_predict(test3)
        revenue_cr3 = result3['total_revenue'] / 10000000
        print(f"Test 3 - International Artist (London, UK):")
        print(f"  Revenue: INR {result3['total_revenue']:,.2f} ({revenue_cr3:.2f} crores)")
        print(f"  Tickets Sold: {result3['tickets_sold']:,}")
        print(f"  Avg Ticket Price: INR {result3['avg_ticket_price']:,.2f}")
        print()
    except Exception as e:
        print(f"Test 3 failed: {e}")

if __name__ == "__main__":
    test_with_sample_data()