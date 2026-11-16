# FlightCostMonitoring

Once a day a GitHub Action asks SerpApi (Google Flights) for prices on the routes in
`config/routes.json` and commits the results as JSON under `data/`. A static GitHub Pages
dashboard can read those files directly.

## Current route

Warsaw (WAW), Wroclaw (WRO), Berlin (BER) and Prague (PRG) to Bangkok (BKK and DMK),
out 2027-01-19, back 2027-02-03, 02-04 or 02-05. 3 adults (the 12-year-old pays adult fare),
economy, premium airlines only (Star Alliance, oneworld, Emirates, Etihad), at most 1 stop, at most 24 h per direction. Options over 16 h in
either direction are kept but marked `long_trip: true` with a `duration_label`
(the return direction is only known for the cheapest few deals). Prices are in PLN and are the
round-trip total for all three passengers.

## How it works

- `scripts/fetch_prices.py` makes one SerpApi search per return date and airport group.
  Google Flights takes at most 7 airports per search, so origins are split into groups of 7
  (`max_airports_per_search`); this route fits in 1 group, so 3 searches per run.
- It checks the remaining SerpApi quota first (that check is free). Searches left over after
  reserving enough for every remaining run this month are spent on fetching the actual
  return flights for the cheapest deals (`return_details_top_n` per route at most). On the
  free plan (250/month) with one run a day that is usually the full `return_details_top_n`.
- Google Flights has no checked-bag data, so every airline gets a flag from
  `config/airlines_baggage.json`: `included`, `fare-dependent`, `extra` or `unknown`.
  An itinerary takes the worst flag of its airlines. Always confirm on the airline site.

## Second source: direct Google Flights scraping

`scripts/scrape_prices.py` reads Google Flights pages directly with the
[fast-flights](https://pypi.org/project/fast-flights/) package, so it needs no API key and
uses no quota. It has its own workflow, "Scrape Google Flights"
(`.github/workflows/scrape-prices.yml`), which runs daily at 11:00 UTC (12:00 in Poland in winter) and can be started
by hand from the Actions tab ("Run workflow") at no cost. It makes one request per outbound date, return date
and origin, limited to the airlines in the route's `scraper.airlines` (the same premium
airlines as the API search). `scraper.outbound_flex_days: 2` also checks departures 2 days
either side of `outbound_date` (17-21 Jan, about 60 requests a run); the dashboard's "± 2 days"
switch shows them. Google may block or change the page at any
time, so a blocked request is recorded in the snapshot instead of failing the run. Results go to
`data/<route_id>/scraped_latest.json` and `scraped_history.json`.

## Data files (for the dashboard)

| File | Contents |
| --- | --- |
| `data/index.json` | Every route with its newest and all-time cheapest price |
| `data/<route_id>/latest.json` | Full newest snapshot: every option, legs, layovers, baggage flags, Google Flights link, price insights |
| `data/<route_id>/history.json` | One row per run and return date: cheapest price, airline, origin, and cheapest price per origin airport |
| `data/usage.json` | Searches this script spent per month |

## Dashboard (GitHub Pages)

`site/` is a static page (plain HTML, CSS and JavaScript, no build step) that reads the
JSON files above. `.github/workflows/pages.yml` copies `site/`, `data/` and `config/` to
GitHub Pages on every push to `main` that touches them and after every "Fetch flight prices"
or "Scrape Google Flights" run, so the page is at most a few minutes behind the latest check. It shows the cheapest
price now (total and per person), a table of the cheapest option per airport and return
date, every current option with checked-bag flags, source (API or scraper) and a Google
Flights link, a "longer trip" label above 16 h per direction (the fetcher's `long_trip` flag, or `long_trip_minutes`
on the route), and the price trend per return date.

One-time setup: Settings, Pages, "Build and deployment", Source: **GitHub Actions**.

Preview locally from the repository root: `python -m http.server`, then open
http://localhost:8000/site/ (the page falls back to `../data/` when served that way).

## Bangkok hotels

A second dashboard page, `site/hotels.html` (linked from the flight page), tracks 5-star
Bangkok hotels for the first and last nights of the trip: 2 adults and a 12-year-old in one room.
The hotels in `config/hotels.json` were picked for 5 stars, an outdoor pool, a high-rise building,
good reviews and a BTS or MRT station within a short walk; edit the list there.

- Stays: first stay check-in 18-22 Jan (flights leave 17-21 Jan), last stay check-out
  3-5 Feb (the flight home), each 3, 4 or 5 nights.
- `scripts/fetch_hotels.py` asks the free [Xotelo](https://xotelo.com) API for each hotel's rates
  for every stay option. Xotelo returns what Tripadvisor shows from Booking.com, Agoda, Expedia,
  Trip.com and others: one nightly rate per room per site for these guests. No API key and no
  SerpApi quota. About 300 requests a run. Prices come in EUR and are shown in PLN at the NBP rate of the day.
- Hotel keys are found by name in Tripadvisor's Bangkok list (`match` / `match_exclude` in the
  config, cached in `data/hotels/keys.json`); set `key` on a hotel to pin it. Review scores
  come from the same list.
- Workflow "Fetch hotel prices" (`.github/workflows/fetch-hotels.yml`) runs daily at 08:00 UTC
  (09:00 in Poland in winter) and can be started by hand. Results go to `data/hotels/latest.json`
  and `history.json`; the Pages site redeploys after each run.
- Prices may leave out taxes and fees, and a room for 3 may need an extra bed or family room,
  so the page links each hotel to Booking.com with the dates and guests filled in.

## Adding or changing a route

Add an object to `routes` in `config/routes.json` with a new `id`. Limit airlines with `include_airlines` (2-letter IATA codes and/or `STAR_ALLIANCE`,
`SKYTEAM`, `ONEWORLD`) or `exclude_airlines`; Google Flights allows one or the other. Set `"enabled": false`
to pause a route without deleting its history. Each return date costs one search per run,
so check the budget: runs per day x airport groups x return dates x 31 should stay under the monthly quota.

## Running

- Automatically at 06:00 UTC: 07:00 in Poland in winter, 08:00 in summer (GitHub cron is UTC). GitHub often starts scheduled runs 5-30 minutes late.
- Manually: Actions tab, "Fetch flight prices", "Run workflow" (optionally one route id).
- Locally without a key: `DRY_RUN=1 python scripts/fetch_prices.py` uses the fixtures in
  `tests/fixtures` (it overwrites `data/`, so don't commit that output).
- Tests: `python -m unittest discover -s tests -v`

Needs the repository secret `SERPAPI_KEY`.
