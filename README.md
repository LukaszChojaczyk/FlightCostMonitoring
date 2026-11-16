# FlightCostMonitoring

Once a day a GitHub Action asks SerpApi (Google Flights) for prices on the routes in
`config/routes.json` and commits the results as JSON under `data/`. A static GitHub Pages
dashboard can read those files directly.

## Current route

14 Polish, German and Czech airports (WAW, KRK, KTW, GDN, WRO, POZ, BER, PRG, WMI, RZE,
LUZ, SZZ, BZG, LCJ) to Bangkok (BKK and DMK),
out 2027-01-19, back 2027-02-03, 02-04 or 02-05. 3 adults (the 12-year-old pays adult fare),
economy, at most 1 stop, at most 16 h per direction. Prices are in PLN and are the
round-trip total for all three passengers.

## How it works

- `scripts/fetch_prices.py` makes one SerpApi search per return date and airport group.
  Google Flights takes at most 7 airports per search, so origins are split into groups of 7
  (`max_airports_per_search`); this route has 2 groups, so 6 searches per run.
- It checks the remaining SerpApi quota first (that check is free). Searches left over after
  reserving enough for every remaining run this month are spent on fetching the actual
  return flights for the cheapest deals (`return_details_top_n` per route at most). On the
  free plan (250/month) that is usually one or two extra searches per run.
- Google Flights has no checked-bag data, so every airline gets a flag from
  `config/airlines_baggage.json`: `included`, `fare-dependent`, `extra` or `unknown`.
  An itinerary takes the worst flag of its airlines. Always confirm on the airline site.

## Data files (for the dashboard)

| File | Contents |
| --- | --- |
| `data/index.json` | Every route with its newest and all-time cheapest price |
| `data/<route_id>/latest.json` | Full newest snapshot: every option, legs, layovers, baggage flags, Google Flights link, price insights |
| `data/<route_id>/history.json` | One row per run and return date: cheapest price, airline, origin, and cheapest price per origin airport |
| `data/usage.json` | Searches this script spent per month |

## Adding or changing a route

Add an object to `routes` in `config/routes.json` with a new `id`. Set `"enabled": false`
to pause a route without deleting its history. Each return date costs one search per run,
so check the budget: runs per day x airport groups x return dates x 31 should stay under the monthly quota.

## Running

- Automatically at 05:23 UTC (06:23 in Poland).
- Manually: Actions tab, "Fetch flight prices", "Run workflow" (optionally one route id).
- Locally without a key: `DRY_RUN=1 python scripts/fetch_prices.py` uses the fixtures in
  `tests/fixtures` (it overwrites `data/`, so don't commit that output).
- Tests: `python -m unittest discover -s tests -v`

Needs the repository secret `SERPAPI_KEY`.
