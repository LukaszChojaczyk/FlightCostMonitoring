import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import fetch_prices as fp  # noqa: E402


class BudgetTests(unittest.TestCase):
    def test_free_plan_leaves_about_one_extra_per_run(self):
        # 1st of a 30-day month, 250 left, 3 base searches, 2 runs/day -> 60 runs * 3 = 180 base
        now = datetime(2026, 11, 1, 6, tzinfo=timezone.utc)
        extra = fp.plan_extra_searches(searches_left=250, base_per_run=3, runs_per_day=2, reserve=10, now=now)
        self.assertEqual(extra, 1)

    def test_no_extra_when_budget_tight(self):
        now = datetime(2026, 11, 20, tzinfo=timezone.utc)
        extra = fp.plan_extra_searches(searches_left=60, base_per_run=3, runs_per_day=2, reserve=10, now=now)
        self.assertEqual(extra, 0)

    def test_extra_grows_at_month_end(self):
        now = datetime(2026, 11, 30, tzinfo=timezone.utc)
        extra = fp.plan_extra_searches(searches_left=40, base_per_run=3, runs_per_day=2, reserve=10, now=now)
        self.assertEqual(extra, 12)


class ParamsTests(unittest.TestCase):
    def test_route_maps_to_serpapi_params(self):
        cfg = fp.load_json(fp.CONFIG_PATH, None)
        route = cfg["routes"][0]
        groups = fp.origin_groups(route, cfg["settings"])
        self.assertTrue(all(len(g) <= 7 for g in groups))
        self.assertEqual(sum(groups, []), route["origins"])
        self.assertEqual(fp.searches_per_run(route, cfg["settings"]), 3)
        p = fp.base_params(route, cfg["settings"], "2027-02-04", groups[0])
        self.assertEqual(p["departure_id"].split(","), groups[0])
        self.assertIn("WAW", p["departure_id"].split(","))
        self.assertEqual(p["arrival_id"], "BKK,DMK")
        self.assertEqual(p["adults"], 3)
        self.assertEqual(p["stops"], 2)  # SerpApi: 2 = one stop or fewer
        self.assertEqual(p["max_duration"], 1200)
        self.assertEqual(p["type"], 1)
        self.assertEqual(p["currency"], "PLN")
        self.assertEqual(p["include_airlines"], "STAR_ALLIANCE,ONEWORLD,EK,EY")
        self.assertNotIn("exclude_airlines", p)


class DryRunTests(unittest.TestCase):
    def test_dry_run_writes_dashboard_files(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(fp, "DATA_DIR", Path(tmp)), \
                mock.patch.dict(os.environ, {"DRY_RUN": "1", "SERPAPI_KEY": ""}):
            self.assertEqual(fp.main(), 0)
            rid = "pl-ber-prg-bkk-2027-01"
            latest = fp.load_json(Path(tmp) / rid / "latest.json", None)
            history = fp.load_json(Path(tmp) / rid / "history.json", None)
            index = fp.load_json(Path(tmp) / "index.json", None)

        self.assertEqual(len(latest["results"]), 3)
        opts = latest["results"][0]["options"]
        self.assertEqual([o["price"] for o in opts], [8120, 9870, 10450])  # cheapest first
        self.assertEqual(opts[0]["baggage_flag"], "extra")          # flydubai
        self.assertEqual(opts[1]["baggage_flag"], "fare-dependent")  # Etihad
        self.assertEqual(opts[2]["baggage_flag"], "included")       # Qatar
        self.assertEqual(opts[0]["price_per_person"], 2707)
        self.assertEqual(opts[0]["destination"], "DMK")
        self.assertEqual(len(history["entries"]), 3)
        self.assertEqual(history["entries"][0]["min_price_by_origin"], {"BER": 8120, "PRG": 9870, "WAW": 10450})
        self.assertEqual(index["routes"][0]["latest_min_price"], 8120)


class NoResultsTests(unittest.TestCase):
    def test_empty_google_answer_is_not_an_error(self):
        cfg = fp.load_json(fp.CONFIG_PATH, None)
        client = mock.Mock(spec=fp.SerpApiClient)
        client.search.side_effect = fp.NoResults("Google Flights hasn't returned any results for this query.")
        snap, used = fp.fetch_route(client, cfg["routes"][0], cfg["settings"], {"default": {}, "airlines": {}}, 0, "t")
        r = snap["results"][0]
        self.assertIsNone(r["error"])
        self.assertEqual(r["options"], [])
        self.assertEqual(r["origin_groups_without_results"], [["WAW", "WRO", "BER", "PRG"]])

    def test_long_origin_lists_are_split_into_groups_of_seven(self):
        route = {"origins": [f"A{i}" for i in range(15)]}
        self.assertEqual([len(g) for g in fp.origin_groups(route, {})], [7, 7, 1])


if __name__ == "__main__":
    unittest.main()
