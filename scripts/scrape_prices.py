#!/usr/bin/env python3
"""Scrape Google Flights directly (no API key, no quota) as a second source.

Uses the fast-flights package, which builds the same `tfs` URL the Google Flights
website uses and parses the returned page. Google can change that page or block
requests at any time, so this is a fallback next to SerpApi, not a replacement.

For every route with "scraper": {"enabled": true, ...} in config/routes.json it runs
one query per origin airport and return date, limited to the scraper's airlines, and writes
  data/<route_id>/scraped_latest.json
  data/<route_id>/scraped_history.json
A failed query is recorded in the snapshot and never fails the run.
"""
from __future__ import annotations

import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_prices import (  # noqa: E402
    BAGGAGE_PATH, CONFIG_PATH, DATA_DIR, MAX_HISTORY_ENTRIES, baggage_for, load_json, save_json, worst_baggage,
)

PAUSE_SECONDS = 3  # be gentle: one request every few seconds


def _dt(sdt) -> str | None:
    """fast-flights SimpleDatetime -> 'YYYY-MM-DD HH:MM'."""
    try:
        y, m, d = sdt.date
        hh, mm = sdt.time
        return f"{y:04d}-{m:02d}-{d:02d} {hh:02d}:{mm:02d}"
    except Exception:  # noqa: BLE001
        return None


def normalize(f, pax: int, bag_table: dict) -> dict:
    legs = list(f.flights or [])
    airlines = list(dict.fromkeys(f.airlines or []))
    baggage = [baggage_for(a, bag_table) for a in airlines]
    total = sum(l.duration or 0 for l in legs)
    first, last = (legs[0], legs[-1]) if legs else (None, None)
    return {
        "price": f.price,
        "price_per_person": round(f.price / pax) if f.price and pax else None,
        "origin": first.from_airport.code if first else None,
        "destination": last.to_airport.code if last else None,
        "departure_time": _dt(first.departure) if first else None,
        "arrival_time": _dt(last.arrival) if last else None,
        "flying_minutes": total,
        "stops": max(0, len(legs) - 1),
        "via": [l.to_airport.code for l in legs[:-1]],
        "airlines": airlines,
        "legs": [
            {"from": l.from_airport.code, "to": l.to_airport.code,
             "departure_time": _dt(l.departure), "arrival_time": _dt(l.arrival),
             "duration_minutes": l.duration, "airplane": l.plane_type}
            for l in legs
        ],
        "baggage": baggage,
        "baggage_flag": worst_baggage(baggage),
    }


def scrape_route(ff, route: dict, settings: dict, bag_table: dict, now_iso: str, pause: float = PAUSE_SECONDS) -> dict:
    sc = route["scraper"]
    pax_cfg = route["passengers"]
    pax = sum(pax_cfg.values())
    dest = sc.get("destination") or route["destinations"][0]
    currency = route.get("currency", settings.get("currency", "PLN"))
    results = []
    first = True
    for rd in route["return_dates"]:
        options, errors = [], []
        for origin in sc.get("origins") or route["origins"]:
            if not first:
                time.sleep(pause)
            first = False
            common = dict(max_stops=route.get("max_stops"), airlines=sc.get("airlines"),
                          max_duration_minutes=route.get("max_duration_minutes"))
            query = ff.create_query(
                flights=[
                    ff.FlightQuery(date=route["outbound_date"], from_airport=origin, to_airport=dest, **common),
                    ff.FlightQuery(date=rd, from_airport=dest, to_airport=origin, **common),
                ],
                trip="round-trip",
                seat=route.get("travel_class", "economy").replace("_", "-"),
                passengers=ff.Passengers(adults=pax_cfg.get("adults", 1), children=pax_cfg.get("children", 0),
                                         infants_in_seat=pax_cfg.get("infants_in_seat", 0),
                                         infants_on_lap=pax_cfg.get("infants_on_lap", 0)),
                language="en-US",
                currency=currency,
            )
            try:
                found = ff.get_flights(query)
            except ff.FlightsNotFound:
                continue
            except Exception as exc:  # noqa: BLE001 - one blocked page must not stop the rest
                errors.append(f"{origin}: {type(exc).__name__}: {exc}")
                print(f"scrape error {route['id']} {origin} back {rd}: {exc}", file=sys.stderr)
                continue
            for f in found or []:
                if f.price:
                    options.append(normalize(f, pax, bag_table))
        options.sort(key=lambda o: o["price"])
        results.append({"return_date": rd, "errors": errors, "options": options})
    return {
        "source": "google-flights-scrape",
        "fetched_at": now_iso,
        "airlines_filter": sc.get("airlines"),
        "destination": dest,
        "price_note": "Round-trip totals for all passengers as shown on Google Flights, outbound flights only.",
        "results": results,
    }


def summarize(snapshot: dict) -> list[dict]:
    rows = []
    for r in snapshot["results"]:
        best = r["options"][0] if r["options"] else None
        rows.append({
            "fetched_at": snapshot["fetched_at"],
            "return_date": r["return_date"],
            "min_price": best["price"] if best else None,
            "min_price_airlines": best["airlines"] if best else None,
            "min_price_origin": best["origin"] if best else None,
            "options_count": len(r["options"]),
            "errors": len(r["errors"]),
        })
    return rows


def main() -> int:
    try:
        import fast_flights as ff
    except ImportError as exc:
        print(f"Could not import fast-flights ({exc}). Install it with: pip install fast-flights typing_extensions",
              file=sys.stderr)
        return 1
    config = load_json(CONFIG_PATH, None)
    settings = config.get("settings", {})
    bag_table = load_json(BAGGAGE_PATH, {"default": {"status": "unknown", "note": ""}, "airlines": {}})
    now_iso = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    for route in config["routes"]:
        if not route.get("enabled", True) or not route.get("scraper", {}).get("enabled"):
            continue
        snap = scrape_route(ff, route, settings, bag_table, now_iso)
        route_dir = DATA_DIR / route["id"]
        save_json(route_dir / "scraped_latest.json", snap)
        hist = load_json(route_dir / "scraped_history.json", {"route_id": route["id"], "entries": []})
        rows = summarize(snap)
        hist["entries"] = (hist["entries"] + rows)[-MAX_HISTORY_ENTRIES:]
        save_json(route_dir / "scraped_history.json", hist)
        print(f"{route['id']} (scraped): " + ", ".join(
            f"{r['return_date']}={r['min_price']} ({r['options_count']} options, {r['errors']} errors)" for r in rows))
    return 0


if __name__ == "__main__":
    sys.exit(main())
