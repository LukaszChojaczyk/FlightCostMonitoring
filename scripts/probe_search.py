#!/usr/bin/env python3
"""One-off SerpApi Google Flights search that prints every option and saves nothing.

Used from the "Probe a search" workflow to debug why a flight is missing.
Each run costs 1 search. Inputs come from environment variables (see the workflow).
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_prices import SerpApiClient, NoResults, collect_options  # noqa: E402


def main() -> int:
    env = os.environ
    params = {
        "departure_id": env["DEPARTURE"], "arrival_id": env["ARRIVAL"],
        "outbound_date": env["OUTBOUND"], "return_date": env["RETURN"], "type": 1,
        "adults": env.get("ADULTS", "3"), "currency": "PLN", "hl": "en", "gl": "pl", "sort_by": 2,
    }
    for key, var in (("include_airlines", "AIRLINES"), ("stops", "STOPS"), ("max_duration", "MAX_DURATION")):
        if env.get(var):
            params[key] = env[var]
    print("Params:", {k: v for k, v in params.items()})
    try:
        resp = SerpApiClient(env["SERPAPI_KEY"]).search(params)
    except NoResults as exc:
        print("No results:", exc)
        return 0
    opts = sorted(collect_options(resp), key=lambda o: o.get("price") or 10**12)
    print(f"{len(opts)} options")
    for o in opts:
        fl = o.get("flights", [])
        path = " > ".join([fl[0]["departure_airport"]["id"]] + [f["arrival_airport"]["id"] for f in fl]) if fl else "?"
        airlines = " + ".join(dict.fromkeys(f.get("airline", "?") for f in fl))
        dur = o.get("total_duration") or 0
        dep = fl[0]["departure_airport"].get("time", "") if fl else ""
        print(f"{o.get('price')!s:>7} PLN  {dur // 60:>2}h{dur % 60:02d}  {dep}  {path:<20} {airlines}")
    print("Google Flights:", resp.get("search_metadata", {}).get("google_flights_url"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
