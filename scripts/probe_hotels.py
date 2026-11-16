#!/usr/bin/env python3
"""TEMPORARY: print raw Xotelo /rates answers for a few parameter variations."""
import json, time, urllib.parse, urllib.request
K = "g293916-d2624290"  # Okura
cases = [
    {"chk_in": "2027-01-20", "chk_out": "2027-01-24"},
    {"chk_in": "2027-01-20", "chk_out": "2027-01-24", "currency": "EUR"},
    {"chk_in": "2027-01-20", "chk_out": "2027-01-24", "adults": 2},
    {"chk_in": "2027-01-20", "chk_out": "2027-01-24", "adults": 2, "age_of_children": "12", "rooms": 1},
    {"chk_in": "2027-01-20", "chk_out": "2027-01-24", "adults": 3},
    {"chk_in": "2026-12-10", "chk_out": "2026-12-12"},
    {"chk_in": "2026-11-25", "chk_out": "2026-11-26"},
]
for c in cases:
    url = "https://data.xotelo.com/api/rates?" + urllib.parse.urlencode({"hotel_key": K, **c})
    t = time.monotonic()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=40) as r:
            body = r.read().decode()
    except Exception as e:
        body = repr(e)
    print(f"{time.monotonic()-t:.1f}s {url}\n{body[:1500]}\n", flush=True)
    time.sleep(2)
url = "https://data.xotelo.com/api/heatmap?" + urllib.parse.urlencode({"hotel_key": K, "chk_out": "2027-01-24"})
with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=40) as r:
    print(url, r.read().decode()[:800])
