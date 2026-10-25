import contextlib
import copy
import json
import os
import sqlite3
import tempfile
import unittest

from app.data.municipalities import MUNICIPALITIES
from app.services import flood_events_service as fe


def event(**over):
    e = {
        "id": "x", "start_date": "2020-01-01", "end_date": "2020-01-02", "period": "2020-01",
        "date_basis": "stated", "kind": "flood", "habagat": True, "province_calamity": False,
        "towns": [{"municipality": "Hermosa", "evidence": "flooded", "barangays": ["Almacen"]}],
        "sources": [{"publisher": "P", "title": "T", "url": "https://example.org/a", "published": "2020-01-02"}],
    }
    e.update(over)
    return e


class RepositoryFileTests(unittest.TestCase):
    def test_repository_file_is_valid(self):
        data, file_hash = fe.read_file()
        self.assertEqual(fe.validate(data, MUNICIPALITIES), [])
        self.assertEqual(len(file_hash), 64)
        self.assertGreaterEqual(len(data["events"]), 25)

    def test_every_event_has_an_https_source_and_known_towns(self):
        data, _ = fe.read_file()
        for e in data["events"]:
            self.assertTrue(e["sources"], e["id"])
            for t in e["towns"]:
                self.assertIn(t["municipality"], MUNICIPALITIES)


class ValidateTests(unittest.TestCase):
    def check(self, *events):
        return fe.validate({"events": list(events)}, MUNICIPALITIES)

    def test_good_event(self):
        self.assertEqual(self.check(event()), [])

    def test_problems_are_reported(self):
        self.assertTrue(self.check(event(date_basis="guess")))
        self.assertTrue(self.check(event(end_date="2019-12-31")))
        self.assertTrue(self.check(event(towns=[{"municipality": "Atlantis", "evidence": "flooded"}])))
        self.assertTrue(self.check(event(towns=[{"municipality": "Hermosa", "evidence": "rumour"}])))
        self.assertTrue(self.check(event(sources=[{"publisher": "P", "title": "T", "url": "http://x", "published": None}])))
        self.assertTrue(self.check(event(sources=[])))
        self.assertTrue(self.check(event(), event()))  # duplicate id
        self.assertTrue(self.check(event(date_basis="not_stated")))  # dates given anyway
        self.assertEqual(self.check(event(date_basis="not_stated", start_date=None, end_date=None)), [])


class ConfidenceTests(unittest.TestCase):
    def test_rule(self):
        self.assertEqual(fe.confidence(event()), "high")
        self.assertEqual(fe.confidence(event(date_basis="inferred")), "high")
        self.assertEqual(fe.confidence(event(date_basis="article_date")), "medium")
        self.assertEqual(fe.confidence(event(towns=[{"municipality": "Hermosa", "evidence": "road"}])), "medium")
        self.assertEqual(fe.confidence(event(date_basis="not_stated", start_date=None, end_date=None)), "low")


class DatabaseTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.dir.name, "t.db")
        self.file = os.path.join(self.dir.name, "events.json")
        self.write({"events": [event(), event(id="y", date_basis="not_stated", start_date=None, end_date=None, period="2021-07")]})

    def tearDown(self):
        self.dir.cleanup()

    def write(self, data):
        with open(self.file, "w", encoding="utf-8") as f:
            json.dump(data, f)

    def connect(self):
        return sqlite3.connect(self.db)

    def test_import_is_idempotent_and_follows_file_changes(self):
        first = fe.ensure_imported(self.connect, self.file, MUNICIPALITIES)
        again = fe.ensure_imported(self.connect, self.file, MUNICIPALITIES)
        self.assertTrue(first["imported"])
        self.assertFalse(again["imported"])
        with contextlib.closing(self.connect()) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM flood_events").fetchone()[0], 2)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM flood_event_towns").fetchone()[0], 2)
        self.write({"events": [event()]})
        self.assertTrue(fe.ensure_imported(self.connect, self.file, MUNICIPALITIES)["imported"])
        with contextlib.closing(self.connect()) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM flood_events").fetchone()[0], 1)

    def test_invalid_file_is_refused_and_db_untouched(self):
        fe.ensure_imported(self.connect, self.file, MUNICIPALITIES)
        self.write({"events": [event(date_basis="guess")]})
        with self.assertRaises(ValueError):
            fe.ensure_imported(self.connect, self.file, MUNICIPALITIES)
        with contextlib.closing(self.connect()) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM flood_events").fetchone()[0], 2)

    def test_report_reads_back_towns_sources_and_counts(self):
        out = fe.events_report(self.connect, self.file, MUNICIPALITIES)
        self.assertEqual(out["count"], 2)
        self.assertEqual(out["by_confidence"], {"high": 1, "medium": 0, "low": 1})
        first = next(e for e in out["events"] if e["id"] == "x")
        self.assertEqual(first["towns"][0]["barangays"], ["Almacen"])
        self.assertEqual(first["sources"][0]["url"], "https://example.org/a")
        hermosa = next(t for t in out["towns"] if t["municipality"] == "Hermosa")
        self.assertEqual((hermosa["flooded"], hermosa["flooded_dated"], hermosa["any_mention"]), (2, 1, 2))


if __name__ == "__main__":
    unittest.main()
