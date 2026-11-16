#!/usr/bin/env python3
"""Fetch Bangkok hotel prices for the hotels and stays in config/hotels.json.

Source: the free Xotelo API (https://xotelo.com), which returns the rates Tripadvisor
shows from Booking.com, Agoda, Expedia, Hotels.com, Trip.com and others. No API key and
no SerpApi quota. Rates are per room per night for the guests in the settings
(2 adults + a 12-year-old), so a stay's total is the cheapest nightly rate x nights.

Writes
  data/hotels/latest.json   every hotel x stay x check-in x nights with every site's rate
  data/hotels/history.json  one entry per run: cheapest total per hotel and stay option
  data/hotels/keys.json     cache of Tripadvisor hotel keys found by name in the city list
A failed request is recorded in the snapshot and never fails the run.

Only the standard library is used, so the GitHub Action needs no pip install.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "hotels.json"
OUT_DIR = ROOT / "data" / "hotels"
XOTELO_URL = "https://data.xotelo.com/api"
NBP_URL = "https://api.nbp.pl/api/exchangerates/rates/a/{cur}/?format=json"
MAX_HISTORY_RUNS = 400  # one run a day: over a year
MAX_LIST_PAGES = 12  # Tripadvisor hotel list pages (100 each, most popular first) scanned for keys and reviews
GIVE_UP_AFTER = 12  # consecutive failed rate requests: the API is blocking us, stop asking
TIME_BUDGET_SECONDS = 18 * 60  # stop asking and save what we have well before the workflow timeout


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def http_json(url: str, timeout: int = 20) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (hotel-price-monitor)", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


class XoteloClient:
    def __init__(self, pause: float = 1.5, get=http_json):
        self.pause = pause
        self.get = get
        self.requests = 0
        self._last = 0.0

    def call(self, endpoint: str, params: dict, retries: int = 2) -> dict:
        url = f"{XOTELO_URL}/{endpoint}?{urllib.parse.urlencode(params)}"
        err = None
        for attempt in range(retries + 1):
            wait = self.pause - (time.monotonic() - self._last)
            if wait > 0 and self.pause:
                time.sleep(wait)
            self._last = time.monotonic()
            self.requests += 1
            try:
                data = self.get(url)
            except Exception as exc:  # noqa: BLE001
                err = f"{type(exc).__name__}: {exc}"
            else:
                if data.get("error"):
                    err = str(data["error"])
                    if isinstance(data["error"], dict):
                        err = data["error"].get("message") or json.dumps(data["error"])
                else:
                    return data.get("result") or {}
            if attempt < retries and self.pause:
                time.sleep(self.pause * (attempt + 2))
        raise RuntimeError(err)


# ------------------------------------------------------------------ stays

def stay_options(stay: dict) -> list[dict]:
    """Every (check-in, check-out, nights) the stay can be. A first stay lists
    check-in dates; a last stay lists check-out dates (the flight home)."""
    out = []
    for n in stay["nights"]:
        for d in stay.get("checkin_dates", []):
            ci = date.fromisoformat(d)
            out.append({"chk_in": d, "chk_out": (ci + timedelta(days=n)).isoformat(), "nights": n})
        for d in stay.get("checkout_dates", []):
            co = date.fromisoformat(d)
            out.append({"chk_in": (co - timedelta(days=n)).isoformat(), "chk_out": d, "nights": n})
    out.sort(key=lambda o: (o["chk_in"], o["nights"]))
    return out


def anchor_date(stay: dict, opt: dict) -> str:
    """The date the dashboard groups by: check-in for a first stay, check-out for a last one."""
    return opt["chk_out"] if stay.get("checkout_dates") else opt["chk_in"]


# ------------------------------------------------------------------ hotel keys and reviews

def tokens(text: str) -> list[str]:
    return re.sub(r"[^a-z0-9]+", " ", re.sub(r"['\u2019\u2018`]", "", (text or "").lower())).split()


def name_match(hotel: dict, listed_name: str) -> int | None:
    """None if the Tripadvisor name is not this hotel, else how many extra words it has
    (fewer is a closer match). Every word of hotel["match"] (default: its name) must appear
    and no word of hotel["match_exclude"]."""
    have = tokens(listed_name)
    need = tokens(hotel.get("match") or hotel["name"])
    if not need or any(t not in have for t in need):
        return None
    if any(t in have for t in tokens(" ".join(hotel.get("match_exclude", [])))):
        return None
    return len(have) - len(need)


def scan_city_list(client: XoteloClient, hotels: list[dict], settings: dict, cache: dict) -> list[str]:
    """Walk the city's Tripadvisor hotel list (most popular first) to find each hotel's key
    by name, plus its review score and count. The free API has no name search (that one is
    RapidAPI only), so this is how keys are found; they are cached in keys.json."""
    loc = settings.get("tripadvisor_location_key")
    for h in hotels:
        c = cache.get(h["id"])
        if not h.get("key") and c and c.get("match") == (h.get("match") or h["name"]):
            h["key"] = c["key"]
    by_key = {h["key"]: h for h in hotels if h.get("key")}
    best: dict[str, tuple[int, dict, int]] = {}
    errors = []
    for page in range(int(settings.get("list_pages", MAX_LIST_PAGES))):
        try:
            res = client.call("list", {"location_key": loc, "limit": 100, "offset": page * 100, "sort": "popularity"}, retries=1)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"Tripadvisor hotel list page {page + 1} failed: {exc}")
            break
        rows = res.get("list") or []
        for i, row in enumerate(rows):
            rank = page * 100 + i + 1
            h = by_key.get(row.get("key"))
            if h is None:
                for cand in hotels:
                    if cand.get("key"):
                        continue
                    extra = name_match(cand, row.get("name", ""))
                    if extra is not None and (cand["id"] not in best or extra < best[cand["id"]][0]):
                        best[cand["id"]] = (extra, row, rank)
                continue
            _apply_row(h, row, rank)
        seen = {h["id"] for h in by_key.values() if "popularity_rank" in h}
        if len(rows) < 100 or all(h["id"] in seen or h["id"] in best for h in hotels):
            break
    for h in hotels:
        if h["id"] in best and not h.get("key"):
            _, row, rank = best[h["id"]]
            h["key"] = row["key"]
            _apply_row(h, row, rank)
            cache[h["id"]] = {"match": h.get("match") or h["name"], "key": row["key"], "tripadvisor_name": row.get("name")}
            print(f"key {h['id']}: {row['key']} = {row.get('name')}")
        if not h.get("key"):
            errors.append(f"{h['name']}: not found in the Tripadvisor list for {settings.get('city')}; "
                          f"set \"key\" in config/hotels.json")
    return errors


def _apply_row(h: dict, row: dict, rank: int) -> None:
    rs = row.get("review_summary") or {}
    h["rating"] = rs.get("rating")
    h["reviews"] = rs.get("count")
    h["popularity_rank"] = rank
    h["tripadvisor_name"] = row.get("name")
    h["tripadvisor_url"] = row.get("url") or h.get("tripadvisor_url")
    if row.get("price_ranges"):
        h["typical_price_range"] = row["price_ranges"]


# ------------------------------------------------------------------ prices

def normalize_rates(raw: list[dict]) -> list[dict]:
    rates = [{"code": r.get("code"), "name": r.get("name") or r.get("code"), "rate": round(float(r["rate"]), 2)}
             for r in raw or [] if isinstance(r.get("rate"), (int, float)) and r["rate"] > 0]
    rates.sort(key=lambda r: r["rate"])
    return rates


def quote(client: XoteloClient, hotel: dict, stay: dict, opt: dict, settings: dict, fx: float | None) -> dict:
    q = {"hotel": hotel["id"], "stay": stay["id"], "date": anchor_date(stay, opt), **opt,
         "rates": [], "min_rate": None, "min_site": None, "total": None, "total_pln": None, "error": None}
    params = {"hotel_key": hotel["key"], "chk_in": opt["chk_in"], "chk_out": opt["chk_out"],
              "currency": settings.get("currency", "EUR"), "rooms": settings.get("rooms", 1),
              "adults": settings.get("adults", 2)}
    if settings.get("children_ages"):
        params["age_of_children"] = ",".join(str(a) for a in settings["children_ages"])
    try:
        res = client.call("rates", params, retries=1)
    except Exception as exc:  # noqa: BLE001
        q["error"] = str(exc)
        return q
    q["rates"] = normalize_rates(res.get("rates"))
    if q["rates"]:
        best = q["rates"][0]
        q["min_rate"] = best["rate"]
        q["min_site"] = best["name"]
        q["total"] = round(best["rate"] * opt["nights"])
        q["total_pln"] = round(q["total"] * fx) if fx else None
    return q


def eur_pln(currency: str, previous: float | None) -> tuple[float | None, str]:
    if currency == "PLN":
        return 1.0, "PLN"
    try:
        data = http_json(NBP_URL.format(cur=currency.lower()), timeout=20)
        r = data["rates"][0]
        return float(r["mid"]), f"NBP table {r.get('no')} of {r.get('effectiveDate')}"
    except Exception as exc:  # noqa: BLE001
        print(f"NBP rate failed: {exc}", file=sys.stderr)
        return previous, "NBP unavailable, previous rate reused" if previous else "no rate"


def batch_hotels(config: dict, batch: int = 0, of: int = 1) -> list[dict]:
    """Enabled hotels in batch `batch` of `of` (every of-th hotel, so batches stay even)."""
    hotels = [dict(h) for h in config["hotels"] if h.get("enabled", True)]
    return [h for i, h in enumerate(hotels) if i % of == batch]


def run(client: XoteloClient, config: dict, now_iso: str, fx: float | None, fx_source: str, cache: dict,
        batch: int = 0, of: int = 1) -> dict:
    settings = config["settings"]
    hotels = batch_hotels(config, batch, of)
    errors = scan_city_list(client, hotels, settings, cache)
    quotes, failed_in_row, gave_up = [], 0, False
    started = time.monotonic()
    budget = float(settings.get("time_budget_seconds", TIME_BUDGET_SECONDS))
    total = sum(len(stay_options(s)) for s in config["stays"]) * sum(1 for h in hotels if h.get("key"))
    for stay in config["stays"]:
        for opt in stay_options(stay):
            for h in hotels:
                if not h.get("key"):
                    continue
                if gave_up:
                    break
                if time.monotonic() - started > budget:
                    gave_up = True
                    errors.append(f"Time budget used up after {len(quotes)} of {total} price requests; the rest are skipped this run")
                    break
                t0 = time.monotonic()
                q = quote(client, h, stay, opt, settings, fx)
                quotes.append(q)
                print(f"[{len(quotes)}/{total}] {h['id']} {opt['chk_in']}+{opt['nights']}: "
                      f"{q['min_rate'] if q['total'] is not None else q['error'] or 'no rates'} ({time.monotonic() - t0:.1f}s)", flush=True)
                failed_in_row = failed_in_row + 1 if q["error"] else 0
                if failed_in_row >= GIVE_UP_AFTER:
                    gave_up = True
                    errors.append(f"Stopped after {GIVE_UP_AFTER} failed requests in a row (last: {q['error']})")
    return {
        "source": "xotelo (Tripadvisor rates)",
        "fetched_at": now_iso,
        "currency": settings.get("currency", "EUR"),
        "pln_rate": fx,
        "pln_rate_source": fx_source,
        "guests": {"rooms": settings.get("rooms", 1), "adults": settings.get("adults", 2),
                   "children_ages": settings.get("children_ages", [])},
        "price_note": "Cheapest nightly rate shown on Tripadvisor for one room and these guests, times nights. "
                      "Sites may add taxes and fees at checkout.",
        "requests": client.requests,
        "errors": errors,
        "hotels": [{k: h.get(k) for k in ("id", "name", "key", "tripadvisor_name", "tripadvisor_url", "rating",
                                          "reviews", "popularity_rank", "typical_price_range")} for h in hotels],
        "quotes": quotes,
    }


def history_entry(snap: dict) -> dict:
    prices = {f"{q['hotel']}|{q['stay']}|{q['chk_in']}|{q['nights']}": q["total"]
              for q in snap["quotes"] if q["total"] is not None}
    return {"fetched_at": snap["fetched_at"], "pln_rate": snap["pln_rate"], "prices": prices}


def merge_parts(parts: list[dict], config: dict) -> tuple[dict, dict]:
    """Join batch snapshots into one snapshot (hotels in config order) and one key cache."""
    if not parts:
        raise ValueError("no batch results to merge")
    order = {h["id"]: i for i, h in enumerate(config["hotels"])}
    snap = {k: v for k, v in parts[0].items() if k not in ("keys_cache", "batch")}
    snap["hotels"] = sorted((h for p in parts for h in p["hotels"]), key=lambda h: order.get(h["id"], 999))
    snap["quotes"] = [q for p in parts for q in p["quotes"]]
    snap["errors"] = [e for p in parts for e in p["errors"]]
    snap["requests"] = sum(p.get("requests", 0) for p in parts)
    snap["batches"] = len(parts)
    cache = {}
    for p in parts:
        cache.update(p.get("keys_cache") or {})
    return snap, cache


def save_outputs(snap: dict, cache: dict) -> None:
    prev = load_json(OUT_DIR / "latest.json", {})
    save_json(OUT_DIR / "keys.json", {**load_json(OUT_DIR / "keys.json", {}), **cache})
    priced = [q for q in snap["quotes"] if q["total"] is not None]
    failed = [q for q in snap["quotes"] if q["error"]]
    if not priced and prev.get("quotes"):
        # keep the last good snapshot on the dashboard; the failure still shows in the log
        print("No prices this run; latest.json left unchanged.", file=sys.stderr)
    else:
        save_json(OUT_DIR / "latest.json", snap)
    if priced:
        hist = load_json(OUT_DIR / "history.json", {"entries": []})
        hist["entries"] = (hist["entries"] + [history_entry(snap)])[-MAX_HISTORY_RUNS:]
        save_json(OUT_DIR / "history.json", hist)
    print(f"{snap['requests']} requests, {len(priced)} priced, {len(failed)} failed, EUR/PLN {snap['pln_rate']} ({snap['pln_rate_source']})")
    for e in snap["errors"]:
        print("error:", e, file=sys.stderr)
    for q in failed[:5]:
        print(f"failed {q['hotel']} {q['chk_in']}+{q['nights']}: {q['error']}", file=sys.stderr)
    for h in snap["hotels"]:
        best = min((q for q in priced if q["hotel"] == h["id"]), key=lambda q: q["min_rate"], default=None)
        print(f"  {h['name']}: key {h['key']}, rating {h.get('rating')} ({h.get('reviews')}), "
              f"cheapest night {best and best['min_rate']} {snap['currency']} ({best and best['min_site']})")


def main(argv: list[str] | None = None) -> int:
    """No arguments: fetch every hotel and save. The workflow runs batches in parallel instead:
      fetch_hotels.py --batch 0 --of 4 --out part.json   fetch one batch into a partial file
      fetch_hotels.py --merge DIR                         join DIR/*.json and save"""
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch", type=int, default=0)
    ap.add_argument("--of", type=int, default=1)
    ap.add_argument("--out")
    ap.add_argument("--merge")
    args = ap.parse_args(argv)
    config = load_json(CONFIG_PATH, None)
    if args.merge:
        parts = [load_json(p, None) for p in sorted(Path(args.merge).rglob("*.json"))]
        parts = [p for p in parts if p and "quotes" in p]
        print(f"merging {len(parts)} batches")
        snap, cache = merge_parts(parts, config)
        save_outputs(snap, cache)
        return 0
    settings = config["settings"]
    prev = load_json(OUT_DIR / "latest.json", {})
    fx, fx_source = eur_pln(settings.get("currency", "EUR"), prev.get("pln_rate"))
    cache = load_json(OUT_DIR / "keys.json", {})
    client = XoteloClient(pause=float(settings.get("pause_seconds", 1.5)))
    now_iso = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    snap = run(client, config, now_iso, fx, fx_source, cache, args.batch, args.of)
    if args.out:
        own = {h["id"] for h in snap["hotels"]}
        save_json(Path(args.out), {**snap, "batch": args.batch, "keys_cache": {k: v for k, v in cache.items() if k in own}})
        priced = sum(1 for q in snap["quotes"] if q["total"] is not None)
        print(f"batch {args.batch + 1}/{args.of}: {client.requests} requests, {priced} of {len(snap['quotes'])} priced")
        return 0
    save_outputs(snap, cache)
    return 0


if __name__ == "__main__":
    sys.exit(main())
