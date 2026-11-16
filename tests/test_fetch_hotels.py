import sys
import unittest
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import fetch_hotels as fh  # noqa: E402

CONFIG = {
    "settings": {"city": "Bangkok", "tripadvisor_location_key": "g293916", "currency": "EUR",
                 "rooms": 1, "adults": 2, "children_ages": [12]},
    "stays": [
        {"id": "first", "checkin_dates": ["2027-01-19", "2027-01-20"], "nights": [3, 4]},
        {"id": "last", "checkout_dates": ["2027-02-04"], "nights": [3]},
    ],
    "hotels": [
        {"id": "a", "name": "Hotel A", "key": "g293916-d1"},
        {"id": "b", "name": "Hotel B", "match": "Grand B", "match_exclude": ["riverside"]},
        {"id": "c", "name": "Hotel C", "match": "Nowhere"},
    ],
}


class FakeApi:
    """Stands in for http_json: answers like data.xotelo.com."""

    def __init__(self):
        self.urls = []

    def __call__(self, url):
        self.urls.append(url)
        endpoint = url.split("/api/")[1].split("?")[0]
        q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(url).query))
        if endpoint == "search":
            return {"error": "This endpoint is available only for RapidAPI"}
        if endpoint == "list":
            return {"error": None, "result": {"list": [
                {"key": "g293916-d1", "name": "Hotel A", "review_summary": {"rating": 4.5, "count": 1200}},
                {"key": "g293916-d7", "name": "Grand B Riverside", "review_summary": {"rating": 4, "count": 10}},
                {"key": "g293916-d8", "name": "The Grand B Hotel, Sukhumvit Collection", "review_summary": {"rating": 4, "count": 10}},
                {"key": "g293916-d2", "name": "Grand B Bangkok", "url": "https://ta/b", "review_summary": {"rating": 5, "count": 800}},
            ]}}
        if endpoint == "rates":
            if q["hotel_key"] == "g293916-d2" and q["chk_in"] == "2027-02-01":
                return {"error": {"message": "Hotel not available"}, "result": None}
            base = 100 if q["hotel_key"].endswith("d1") else 150
            return {"error": None, "result": {"rates": [
                {"code": "Agoda", "name": "Agoda.com", "rate": base + 10},
                {"code": "BookingCom", "name": "Booking.com", "rate": base},
                {"code": "X", "name": "Broken", "rate": 0},
            ]}}
        raise AssertionError(url)


class StayOptionsTest(unittest.TestCase):
    def test_first_stay_counts_from_checkin(self):
        opts = fh.stay_options(CONFIG["stays"][0])
        self.assertEqual(len(opts), 4)
        self.assertIn({"chk_in": "2027-01-20", "chk_out": "2027-01-24", "nights": 4}, opts)

    def test_last_stay_counts_back_from_checkout(self):
        opts = fh.stay_options(CONFIG["stays"][1])
        self.assertEqual(opts, [{"chk_in": "2027-02-01", "chk_out": "2027-02-04", "nights": 3}])
        self.assertEqual(fh.anchor_date(CONFIG["stays"][1], opts[0]), "2027-02-04")


class PairStayTest(unittest.TestCase):
    def test_stay_between_takes_every_checkin_checkout_pair(self):
        stay = {"id": "middle", "checkin_dates": ["2027-01-23", "2027-01-24"], "checkout_dates": ["2027-01-30", "2027-01-31"]}
        opts = fh.stay_options(stay)
        self.assertEqual([o["nights"] for o in opts], [7, 8, 6, 7])
        self.assertEqual(fh.anchor_date(stay, opts[0]), "2027-01-23")

    def test_city_paths(self):
        self.assertEqual(fh.city_paths("bangkok")[1].name, "hotels")
        cfg, out = fh.city_paths("phuket")
        self.assertEqual((cfg.name, out.name), ("hotels-phuket.json", "hotels-phuket"))
        self.assertTrue(cfg.exists())

    def test_accents_and_curly_apostrophes_match(self):
        self.assertEqual(fh.tokens("Mövenpick Queen’s Park"), ["movenpick", "queens", "park"])


class RunTest(unittest.TestCase):
    def setUp(self):
        self.api = FakeApi()
        self.cache = {}
        client = fh.XoteloClient(pause=0, get=self.api)
        self.snap = fh.run(client, CONFIG, "2026-11-16T08:00:00+00:00", 4.25, "test", self.cache)

    def test_name_match(self):
        h = {"name": "X", "match": "Marriott Marquis Queen's Park"}
        self.assertEqual(fh.name_match(h, "Bangkok Marriott Marquis Queens Park"), 1)
        self.assertIsNone(fh.name_match(h, "Bangkok Marriott Hotel Sukhumvit"))

    def test_keys_found_by_closest_name_and_cached(self):
        hotels = {h["id"]: h for h in self.snap["hotels"]}
        self.assertEqual(hotels["b"]["key"], "g293916-d2")
        self.assertIsNone(hotels["c"]["key"])
        self.assertEqual(self.cache["b"]["key"], "g293916-d2")
        self.assertTrue(any("Hotel C" in e for e in self.snap["errors"]))

    def test_reviews(self):
        a = next(h for h in self.snap["hotels"] if h["id"] == "a")
        self.assertEqual((a["rating"], a["reviews"]), (4.5, 1200))

    def test_quotes_take_cheapest_site_times_nights(self):
        q = next(q for q in self.snap["quotes"] if q["hotel"] == "a" and q["chk_in"] == "2027-01-20" and q["nights"] == 4)
        self.assertEqual((q["min_rate"], q["min_site"], q["total"], q["total_pln"]), (100, "Booking.com", 400, 1700))
        self.assertEqual([r["code"] for r in q["rates"]], ["BookingCom", "Agoda"])
        # 4 first-stay options + 1 last-stay option, for the 2 hotels with a key
        self.assertEqual(len(self.snap["quotes"]), 10)

    def test_guests_sent(self):
        rates = [u for u in self.api.urls if "/rates?" in u]
        self.assertTrue(all("adults=2" in u and "age_of_children=12" in u and "currency=EUR" in u for u in rates))

    def test_error_recorded_not_raised(self):
        q = next(q for q in self.snap["quotes"] if q["hotel"] == "b" and q["stay"] == "last")
        self.assertEqual(q["error"], "Hotel not available")
        self.assertIsNone(q["total"])

    def test_history_entry(self):
        e = fh.history_entry(self.snap)
        self.assertEqual(e["prices"]["a|first|2027-01-20|4"], 400)
        self.assertNotIn("b|last|2027-02-01|3", e["prices"])

    def test_cached_key_reused(self):
        self.cache["b"]["key"] = "g293916-d99"
        snap = fh.run(fh.XoteloClient(pause=0, get=FakeApi()), CONFIG, "t", None, "", self.cache)
        self.assertEqual(next(h for h in snap["hotels"] if h["id"] == "b")["key"], "g293916-d99")


class BatchTest(unittest.TestCase):
    def test_batches_split_and_merge_back(self):
        parts = []
        for b in range(2):
            cache = {}
            snap = fh.run(fh.XoteloClient(pause=0, get=FakeApi()), CONFIG, "t", 4.0, "x", cache, batch=b, of=2)
            parts.append({**snap, "keys_cache": cache})
        self.assertEqual([h["id"] for h in parts[0]["hotels"]], ["a", "c"])
        self.assertEqual([h["id"] for h in parts[1]["hotels"]], ["b"])
        merged, cache = fh.merge_parts(parts[::-1], CONFIG)
        self.assertEqual([h["id"] for h in merged["hotels"]], ["a", "b", "c"])
        self.assertEqual(len(merged["quotes"]), 10)
        self.assertEqual(cache["b"]["key"], "g293916-d2")
        self.assertNotIn("keys_cache", merged)


if __name__ == "__main__":
    unittest.main()
