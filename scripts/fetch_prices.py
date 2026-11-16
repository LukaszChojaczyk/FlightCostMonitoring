#!/usr/bin/env python3
"""Fetch flight prices from SerpApi Google Flights for every route in config/routes.json.

Writes, per route:
  data/<route_id>/latest.json   full snapshot of the newest run (for the dashboard)
  data/<route_id>/history.json  one compact entry per run and return date (price trend)
and a top-level data/index.json listing all routes with their newest cheapest price,
plus data/usage.json counting searches this script spent per month.

Only the standard library is used, so the GitHub Action needs no pip install.
Environment:
  SERPAPI_KEY    required
  ROUTE_ID       optional, only fetch this route
  DRY_RUN=1      read responses from tests/fixtures instead of calling SerpApi
"""
from __future__ import annotations

import calendar
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "routes.json"
BAGGAGE_PATH = ROOT / "config" / "airlines_baggage.json"
DATA_DIR = ROOT / "data"
SEARCH_URL = "https://serpapi.com/search.json"
ACCOUNT_URL = "https://serpapi.com/account.json"
TRAVEL_CLASS = {"economy": 1, "premium_economy": 2, "business": 3, "first": 4}
# SerpApi "stops": 0 any, 1 nonstop only, 2 one stop or fewer, 3 two stops or fewer
STOPS_PARAM = {0: 1, 1: 2, 2: 3}
BAG_RANK = {"included": 0, "fare-dependent": 1, "unknown": 2, "extra": 3}
MAX_HISTORY_ENTRIES = 5000  # per route, ~2 years at 2 runs/day x 3 return dates


# --------------------------------------------------------------------------- io

def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


class SerpApiClient:
    def __init__(self, api_key: str, dry_run: bool = False):
        self.api_key = api_key
        self.dry_run = dry_run
        self.searches = 0

    def _get(self, url: str, params: dict) -> dict:
        query = urllib.parse.urlencode({**params, "api_key": self.api_key})
        req = urllib.request.Request(f"{url}?{query}", headers={"User-Agent": "flight-cost-monitor/1.0"})
        with urllib.request.urlopen(req, timeout=90) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def search(self, params: dict) -> dict:
        self.searches += 1
        if self.dry_run:
            name = "return_legs.json" if "departure_token" in params else "outbound.json"
            return json.loads((ROOT / "tests" / "fixtures" / name).read_text(encoding="utf-8"))
        data = self._get(SEARCH_URL, {"engine": "google_flights", **params})
        if data.get("error"):
            raise RuntimeError(f"SerpApi error: {data['error']}")
        return data

    def searches_left(self) -> int | None:
        """Account API calls are free and don't count toward the quota."""
        if self.dry_run:
            return None
        try:
            acc = self._get(ACCOUNT_URL, {})
            left = acc.get("total_searches_left", acc.get("plan_searches_left"))
            return int(left) if left is not None else None
        except Exception as exc:  # noqa: BLE001 - budget check is best effort
            print(f"warning: could not read SerpApi account usage: {exc}", file=sys.stderr)
            return None


# ----------------------------------------------------------------------- budget

def plan_extra_searches(*, searches_left: int, base_per_run: int, runs_per_day: int,
                        reserve: int, now: datetime) -> int:
    """How many optional searches (return-leg details) this run may spend.

    Keeps enough quota for the base searches of every remaining scheduled run this
    month, then spreads whatever is left evenly over those runs.
    """
    days_in_month = calendar.monthrange(now.year, now.month)[1]
    runs_left = max(1, (days_in_month - now.day + 1) * runs_per_day)
    spare = searches_left - reserve - base_per_run * runs_left
    return max(0, spare // runs_left)


def local_searches_left(usage: dict, budget: int, now: datetime) -> int:
    return budget - usage.get(now.strftime("%Y-%m"), 0)


# -------------------------------------------------------------------- normalize

def baggage_for(airline: str, table: dict) -> dict:
    info = table["airlines"].get(airline)
    if info is None:  # loose match, e.g. "Qatar Airways" vs "Qatar"
        low = airline.lower()
        info = next((v for k, v in table["airlines"].items() if k.lower() in low or low in k.lower()), None)
    info = info or table["default"]
    return {"airline": airline, "status": info["status"], "note": info["note"]}


def worst_baggage(items: list[dict]) -> str:
    if not items:
        return "unknown"
    return max(items, key=lambda b: BAG_RANK.get(b["status"], 2))["status"]


def normalize_option(opt: dict, pax: int, bag_table: dict) -> dict:
    flights = opt.get("flights", [])
    airlines = list(dict.fromkeys(f.get("airline", "?") for f in flights))
    baggage = [baggage_for(a, bag_table) for a in airlines]
    price = opt.get("price")
    first, last = (flights[0], flights[-1]) if flights else ({}, {})
    return {
        "price": price,
        "price_per_person": round(price / pax) if isinstance(price, (int, float)) and pax else None,
        "origin": first.get("departure_airport", {}).get("id"),
        "origin_name": first.get("departure_airport", {}).get("name"),
        "destination": last.get("arrival_airport", {}).get("id"),
        "departure_time": first.get("departure_airport", {}).get("time"),
        "arrival_time": last.get("arrival_airport", {}).get("time"),
        "total_duration_minutes": opt.get("total_duration"),
        "stops": max(0, len(flights) - 1),
        "airlines": airlines,
        "legs": [
            {
                "from": f.get("departure_airport", {}).get("id"),
                "to": f.get("arrival_airport", {}).get("id"),
                "departure_time": f.get("departure_airport", {}).get("time"),
                "arrival_time": f.get("arrival_airport", {}).get("time"),
                "airline": f.get("airline"),
                "flight_number": f.get("flight_number"),
                "duration_minutes": f.get("duration"),
                "airplane": f.get("airplane"),
                "overnight": bool(f.get("overnight")),
            }
            for f in flights
        ],
        "layovers": [
            {"airport": l.get("id"), "name": l.get("name"), "duration_minutes": l.get("duration"),
             "overnight": bool(l.get("overnight"))}
            for l in opt.get("layovers", [])
        ],
        "baggage": baggage,
        "baggage_flag": worst_baggage(baggage),
        "extensions": opt.get("extensions", []),
    }


def collect_options(resp: dict) -> list[dict]:
    opts = []
    for group in ("best_flights", "other_flights"):
        for o in resp.get(group, []) or []:
            o = dict(o)
            o["_best"] = group == "best_flights"
            opts.append(o)
    return opts


# ------------------------------------------------------------------------ fetch

def base_params(route: dict, settings: dict, return_date: str) -> dict:
    pax = route["passengers"]
    params = {
        "departure_id": ",".join(route["origins"]),
        "arrival_id": ",".join(route["destinations"]),
        "outbound_date": route["outbound_date"],
        "return_date": return_date,
        "type": 1,  # round trip
        "travel_class": TRAVEL_CLASS[route.get("travel_class", "economy")],
        "adults": pax.get("adults", 1),
        "children": pax.get("children", 0),
        "infants_in_seat": pax.get("infants_in_seat", 0),
        "infants_on_lap": pax.get("infants_on_lap", 0),
        "currency": route.get("currency", settings.get("currency", "PLN")),
        "hl": settings.get("hl", "en"),
        "gl": settings.get("gl", "pl"),
        "sort_by": 2,  # price
    }
    if route.get("max_stops") is not None:
        params["stops"] = STOPS_PARAM[route["max_stops"]]
    if route.get("max_duration_minutes"):
        params["max_duration"] = route["max_duration_minutes"]
    return params


def fetch_route(client: SerpApiClient, route: dict, settings: dict, bag_table: dict,
                extra_budget: int, now_iso: str) -> tuple[dict, int]:
    pax = sum(route["passengers"].values())
    results = []
    raw_by_date = []
    for rd in route["return_dates"]:
        params = base_params(route, settings, rd)
        try:
            resp = client.search(params)
            error = None
        except Exception as exc:  # noqa: BLE001 - keep other dates going
            resp, error = {}, str(exc)
            print(f"error: {route['id']} return {rd}: {exc}", file=sys.stderr)
        raw = collect_options(resp)
        raw.sort(key=lambda o: o.get("price") or 10**12)
        options = []
        for o in raw:
            n = normalize_option(o, pax, bag_table)
            n["google_best"] = o["_best"]
            n["return_leg"] = None
            options.append(n)
        raw_by_date.append((rd, params, raw, options))
        results.append({
            "return_date": rd,
            "error": error,
            "google_flights_url": resp.get("search_metadata", {}).get("google_flights_url"),
            "price_insights": resp.get("price_insights"),
            "options": options,
        })

    # Optional: fetch the return flights for the cheapest deals across all dates.
    candidates = [(no["price"] or 10**12, rd, params, ro, no)
                  for rd, params, raw, opts in raw_by_date
                  for ro, no in zip(raw, opts) if ro.get("departure_token")]
    candidates.sort(key=lambda c: c[0])
    used_extra = 0
    for _, rd, params, ro, no in candidates[:min(extra_budget, route.get("return_details_top_n", 0))]:
        try:
            resp = client.search({**params, "departure_token": ro["departure_token"]})
        except Exception as exc:  # noqa: BLE001
            print(f"warning: return leg for {rd} failed: {exc}", file=sys.stderr)
            continue
        used_extra += 1
        legs = sorted(collect_options(resp), key=lambda o: o.get("price") or 10**12)
        if legs:
            back = normalize_option(legs[0], pax, bag_table)
            no["return_leg"] = back
            all_bags = no["baggage"] + [b for b in back["baggage"] if b["airline"] not in no["airlines"]]
            no["baggage"] = all_bags
            no["baggage_flag"] = worst_baggage(all_bags)

    snapshot = {
        "route": {k: route[k] for k in route if k != "enabled"},
        "fetched_at": now_iso,
        "passengers_total": pax,
        "price_note": "Prices are round-trip totals for all passengers, as shown by Google Flights.",
        "results": results,
    }
    return snapshot, used_extra


def summarize(snapshot: dict) -> list[dict]:
    """Compact rows for history.json: one per return date."""
    rows = []
    for r in snapshot["results"]:
        priced = [o for o in r["options"] if isinstance(o["price"], (int, float))]
        if not priced:
            rows.append({"fetched_at": snapshot["fetched_at"], "return_date": r["return_date"],
                         "min_price": None, "error": r["error"]})
            continue
        best = min(priced, key=lambda o: o["price"])
        by_origin: dict[str, int] = {}
        for o in priced:
            if o["origin"] and (o["origin"] not in by_origin or o["price"] < by_origin[o["origin"]]):
                by_origin[o["origin"]] = o["price"]
        rows.append({
            "fetched_at": snapshot["fetched_at"],
            "return_date": r["return_date"],
            "min_price": best["price"],
            "min_price_airlines": best["airlines"],
            "min_price_origin": best["origin"],
            "min_price_destination": best["destination"],
            "min_price_baggage_flag": best["baggage_flag"],
            "min_price_by_origin": dict(sorted(by_origin.items(), key=lambda kv: kv[1])),
            "options_count": len(priced),
            "price_level": (r.get("price_insights") or {}).get("price_level"),
        })
    return rows


# ------------------------------------------------------------------------- main

def main() -> int:
    dry_run = os.environ.get("DRY_RUN") == "1"
    api_key = os.environ.get("SERPAPI_KEY", "")
    if not api_key and not dry_run:
        print("SERPAPI_KEY is not set", file=sys.stderr)
        return 1
    only_route = os.environ.get("ROUTE_ID") or None

    config = load_json(CONFIG_PATH, None)
    settings = config.get("settings", {})
    bag_table = load_json(BAGGAGE_PATH, {"default": {"status": "unknown", "note": ""}, "airlines": {}})
    routes = [r for r in config["routes"] if r.get("enabled", True) and (not only_route or r["id"] == only_route)]
    if not routes:
        print("No enabled routes to fetch.")
        return 0

    now = datetime.now(timezone.utc)
    now_iso = now.replace(microsecond=0).isoformat()
    month = now.strftime("%Y-%m")
    usage_path = DATA_DIR / "usage.json"
    usage = load_json(usage_path, {})

    client = SerpApiClient(api_key, dry_run)
    base_per_run = sum(len(r["return_dates"]) for r in routes)
    left = client.searches_left()
    if left is None:
        left = local_searches_left(usage, settings.get("monthly_search_budget", 250), now)
    if left < base_per_run and not dry_run:
        print(f"Only {left} searches left this month, need {base_per_run}. Skipping run.")
        return 0
    extra_total = plan_extra_searches(
        searches_left=left, base_per_run=base_per_run,
        runs_per_day=settings.get("runs_per_day", 2),
        reserve=settings.get("reserve_searches", 10), now=now)
    print(f"Searches left: {left}; base this run: {base_per_run}; extra allowed: {extra_total}")

    index = load_json(DATA_DIR / "index.json", {"routes": []})
    index_by_id = {r["id"]: r for r in index.get("routes", [])}
    for route in routes:
        snapshot, used = fetch_route(client, route, settings, bag_table, extra_total, now_iso)
        extra_total -= used
        route_dir = DATA_DIR / route["id"]
        save_json(route_dir / "latest.json", snapshot)
        rows = summarize(snapshot)
        history = load_json(route_dir / "history.json", {"route_id": route["id"], "entries": []})
        history["entries"] = (history["entries"] + rows)[-MAX_HISTORY_ENTRIES:]
        save_json(route_dir / "history.json", history)
        prices = [r for r in rows if r.get("min_price") is not None]
        best = min(prices, key=lambda r: r["min_price"]) if prices else None
        all_time = [e["min_price"] for e in history["entries"] if e.get("min_price") is not None]
        index_by_id[route["id"]] = {
            "id": route["id"],
            "name": route["name"],
            "outbound_date": route["outbound_date"],
            "return_dates": route["return_dates"],
            "currency": route.get("currency", settings.get("currency", "PLN")),
            "updated_at": now_iso,
            "latest_min_price": best["min_price"] if best else None,
            "latest_min_return_date": best["return_date"] if best else None,
            "all_time_min_price": min(all_time) if all_time else None,
        }
        print(f"{route['id']}: " + ", ".join(f"{r['return_date']}={r.get('min_price')}" for r in rows))

    index["routes"] = list(index_by_id.values())
    index["updated_at"] = now_iso
    save_json(DATA_DIR / "index.json", index)
    if not dry_run:
        usage[month] = usage.get(month, 0) + client.searches
        save_json(usage_path, usage)
    print(f"Searches used this run: {client.searches}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
