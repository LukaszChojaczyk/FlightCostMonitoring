import sys
import unittest
from pathlib import Path
from types import SimpleNamespace as NS

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import fetch_prices as fp  # noqa: E402
import scrape_prices as sp  # noqa: E402


def leg(a, b, dep, arr, dur):
    return NS(from_airport=NS(code=a, name=a), to_airport=NS(code=b, name=b),
              departure=NS(date=(2027, 1, 19), time=dep), arrival=NS(date=(2027, 1, 20), time=arr),
              duration=dur, plane_type="Boeing 787")


class FakeFastFlights:
    """Stands in for the fast_flights module so tests need no network."""

    class FlightsNotFound(Exception):
        pass

    def __init__(self):
        self.queries = []

    def FlightQuery(self, **kw):
        return kw

    def Passengers(self, **kw):
        return kw

    def create_query(self, **kw):
        return kw

    def get_flights(self, q):
        self.queries.append(q)
        origin = q["flights"][0]["from_airport"]
        if origin == "WRO":
            raise self.FlightsNotFound()
        if origin == "PRG":
            raise RuntimeError("blocked")
        return [
            NS(price=9200, airlines=["Qatar Airways"], type="QR",
               flights=[leg(origin, "DOH", (21, 40), (5, 30), 350), leg("DOH", "BKK", (8, 0), (18, 25), 395)]),
            NS(price=10100, airlines=["Emirates"], type="EK",
               flights=[leg(origin, "DXB", (14, 0), (23, 0), 360), leg("DXB", "BKK", (3, 0), (12, 30), 390)]),
        ]


class ScrapeTests(unittest.TestCase):
    def test_scrape_route_merges_origins_and_records_errors(self):
        cfg = fp.load_json(fp.CONFIG_PATH, None)
        route = cfg["routes"][0]
        bags = fp.load_json(fp.BAGGAGE_PATH, None)
        ff = FakeFastFlights()
        snap = sp.scrape_route(ff, route, cfg["settings"], bags, "2026-11-16T00:00:00+00:00", pause=0)

        days = 2 * route["scraper"].get("outbound_flex_days", 0) + 1
        self.assertEqual(len(ff.queries), days * len(route["origins"]) * len(route["return_dates"]))
        q = ff.queries[0]
        self.assertEqual(q["trip"], "round-trip")
        self.assertEqual(q["flights"][0]["airlines"], route["scraper"]["airlines"])
        self.assertEqual(q["flights"][0]["date"], sp.outbound_dates(route)[0])
        self.assertEqual(q["flights"][1]["from_airport"], "BKK")
        self.assertEqual(q["passengers"]["adults"], 3)

        self.assertEqual(len(snap["results"]), days * len(route["return_dates"]))
        r = snap["results"][0]
        self.assertEqual(r["outbound_date"], sp.outbound_dates(route)[0])
        self.assertEqual(r["errors"], ["PRG: RuntimeError: blocked"])  # WRO had no flights, not an error
        self.assertEqual({o["origin"] for o in r["options"]}, {"WAW", "BER"})
        best = r["options"][0]
        self.assertEqual(best["price"], 9200)
        self.assertEqual(best["via"], ["DOH"])
        self.assertEqual(best["departure_time"], "2027-01-19 21:40")
        self.assertEqual(best["baggage_flag"], "included")
        self.assertEqual(best["price_per_person"], 3067)

        rows = sp.summarize(snap)
        self.assertEqual(rows[0]["min_price"], 9200)
        self.assertEqual(rows[0]["errors"], 1)
        self.assertEqual(rows[0]["outbound_date"], r["outbound_date"])

    def test_outbound_dates_flex(self):
        route = {"outbound_date": "2027-01-19", "scraper": {"outbound_flex_days": 2}}
        self.assertEqual(sp.outbound_dates(route),
                         ["2027-01-17", "2027-01-18", "2027-01-19", "2027-01-20", "2027-01-21"])
        self.assertEqual(sp.outbound_dates({"outbound_date": "2027-01-19", "scraper": {}}), ["2027-01-19"])


if __name__ == "__main__":
    unittest.main()
