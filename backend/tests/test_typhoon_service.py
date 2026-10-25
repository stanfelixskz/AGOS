"""
Typhoon-from-URL extraction. No network: pages, DNS and geocoding are faked.
The sample texts are invented for the tests and describe no real storm.
"""

import socket
import unittest

from app.services import typhoon_service as ts

BULLETIN_TEXT = """
TROPICAL CYCLONE BULLETIN NR. 7
Typhoon "TESTA" (INTLNAME)
Issued at 11:00 AM, 25 October 2026
The center of Typhoon TESTA was estimated based on all available data at 320 km East of Virac, Catanduanes (13.6°N, 127.2°E).
Maximum sustained winds of 150 km/h near the center, gustiness of up to 185 km/h, and central pressure of 960 hPa.
Moving West northwestward at 20 km/h.
Strong to typhoon-force winds extend outwards up to 600 km from the center.
"""

NEWS_TEXT = """
Severe Tropical Storm Testb strengthened on Saturday. The storm was last spotted 410 kilometers east of Virac, Catanduanes.
It has sustained winds of 95 km/h and gusts of up to 115 km/h. The storm has a diameter of 700 km.
It is almost stationary over the Philippine Sea.
"""


def fake_resolve(address):
    def resolve(host, port):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, port))]
    return resolve


def fake_geocode(place):
    if place.startswith("Virac"):
        return {"query": place, "name": "Virac", "admin1": "Bicol", "country": "Philippines", "latitude": 13.58, "longitude": 124.23, "source": "test"}
    return None


class UrlSafetyTests(unittest.TestCase):
    def test_rejects_non_http_schemes(self):
        for url in ("file:///etc/passwd", "ftp://example.com/a", "javascript:alert(1)"):
            with self.assertRaises(ts.UrlRejected):
                ts.validate_public_url(url, fake_resolve("93.184.216.34"))

    def test_rejects_private_and_local_addresses(self):
        for address in ("127.0.0.1", "10.0.0.5", "192.168.1.10", "169.254.169.254", "::1"):
            with self.assertRaises(ts.UrlRejected, msg=address):
                ts.validate_public_url("http://news.example/article", fake_resolve(address))

    def test_rejects_odd_ports_and_credentials(self):
        with self.assertRaises(ts.UrlRejected):
            ts.validate_public_url("http://news.example:8000/a", fake_resolve("93.184.216.34"))
        with self.assertRaises(ts.UrlRejected):
            ts.validate_public_url("http://user:pw@news.example/a", fake_resolve("93.184.216.34"))

    def test_accepts_public_address(self):
        url = "https://news.example/story"
        self.assertEqual(ts.validate_public_url(url, fake_resolve("93.184.216.34")), url)

    def test_redirect_to_private_address_is_rejected(self):
        class Response:
            status_code = 302
            headers = {"Location": "http://internal.example/admin"}
            def close(self):
                pass

        class Session:
            def get(self, url, **kwargs):
                return Response()

        def resolve(host, port):
            address = "10.0.0.1" if host == "internal.example" else "93.184.216.34"
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, port))]

        with self.assertRaises(ts.UrlRejected):
            ts.fetch_page("https://news.example/story", session=Session(), resolve=resolve)


class ExtractionTests(unittest.TestCase):
    def test_bulletin_coordinates_and_characteristics(self):
        r = ts.extract_typhoon(BULLETIN_TEXT, geocode=fake_geocode)
        self.assertEqual(r["storm"]["name"], "Testa")
        self.assertEqual(r["storm"]["category"], "Typhoon")
        self.assertEqual(r["storm"]["international_name"], "INTLNAME")
        self.assertEqual(r["position"]["method"], "coordinates")
        self.assertEqual((r["position"]["latitude"], r["position"]["longitude"]), (13.6, 127.2))
        self.assertEqual(r["position"]["relative"]["place"], "Virac, Catanduanes")
        self.assertEqual(r["max_wind_kmh"]["value"], 150)
        self.assertEqual(r["gust_kmh"]["value"], 185)
        self.assertEqual(r["pressure_hpa"]["value"], 960)
        self.assertEqual(r["movement"]["speed_kmh"], 20)
        self.assertEqual(r["movement"]["bearing_deg"], 292.5)
        self.assertEqual(r["radius_km"]["value"], 600)
        self.assertIn("600 km from the center", r["radius_km"]["evidence"])
        self.assertIn("11:00 AM", r["bulletin_time"]["text"])

    def test_news_relative_position_is_projected_from_geocoded_place(self):
        r = ts.extract_typhoon(NEWS_TEXT, geocode=fake_geocode)
        self.assertEqual(r["storm"]["category"], "Severe Tropical Storm")
        self.assertEqual(r["position"]["method"], "relative")
        self.assertAlmostEqual(r["position"]["latitude"], 13.58, delta=0.1)
        self.assertGreater(r["position"]["longitude"], 127.8)
        self.assertEqual(r["radius_km"]["value"], 350)
        self.assertEqual(r["radius_km"]["basis"], "half of the stated diameter")
        self.assertTrue(r["movement"]["stationary"])

    def test_unknown_place_gives_a_note_not_a_guess(self):
        r = ts.extract_typhoon("Tropical Depression Testc is 500 km east of Nowhereland.", geocode=lambda p: None)
        self.assertIsNone(r["position"])
        self.assertIn("Nowhereland", r["position_note"])

    def test_unreachable_geocoder_is_reported_as_such(self):
        def down(place):
            raise ts.GeocoderUnavailable("down")
        r = ts.extract_typhoon("Typhoon Teste is 410 kilometers east of Aparri, Cagayan.", geocode=down)
        self.assertIsNone(r["position"])
        self.assertIn("could not be reached", r["position_note"])

    def test_movement_without_speed(self):
        r = ts.extract_typhoon("Typhoon Testf is moving west-northwestward with maximum sustained winds of 175 km/h.", geocode=fake_geocode)
        self.assertEqual(r["movement"]["bearing_deg"], 292.5)
        self.assertIsNone(r["movement"]["speed_kmh"])
        self.assertEqual(r["max_wind_kmh"]["value"], 175)

    def test_geocode_retries_then_raises(self):
        import requests

        class Session:
            calls = 0
            def get(self, *args, **kwargs):
                Session.calls += 1
                raise requests.ConnectTimeout("slow")

        ts._geocode_cache.clear()
        with self.assertRaises(ts.GeocoderUnavailable):
            ts.geocode_place("Virac, Catanduanes", session=Session())
        self.assertEqual(Session.calls, ts.GEOCODE_ATTEMPTS)

    def test_geocode_answers_are_cached(self):
        class Response:
            def raise_for_status(self):
                pass
            def json(self):
                return {"results": [{"name": "Virac", "admin1": "Bicol Region", "latitude": 13.58, "longitude": 124.24}]}

        class Session:
            calls = 0
            def get(self, *args, **kwargs):
                Session.calls += 1
                return Response()

        ts._geocode_cache.clear()
        first = ts.geocode_place("Virac, Catanduanes", session=Session())
        second = ts.geocode_place("virac, catanduanes", session=Session())
        self.assertEqual(first, second)
        self.assertEqual(Session.calls, 1)

    def test_text_without_storm_details(self):
        r = ts.extract_typhoon("The city council approved a new budget today.", geocode=fake_geocode)
        self.assertIsNone(r["storm"])
        self.assertIsNone(r["position"])
        self.assertIsNone(r["radius_km"])
        self.assertTrue(r["position_note"])

    def test_signal_is_not_taken_as_a_storm_name(self):
        r = ts.extract_typhoon("Typhoon Signal No. 3 is raised. Typhoon Testd is approaching.", geocode=fake_geocode)
        self.assertEqual(r["storm"]["name"], "Testd")

    def test_destination_point_due_east(self):
        lat, lon = ts.destination_point(0.0, 120.0, 90, 111.195)
        self.assertAlmostEqual(lat, 0.0, places=2)
        self.assertAlmostEqual(lon, 121.0, places=2)


class PageTests(unittest.TestCase):
    def test_html_to_text_skips_scripts_and_reads_meta(self):
        html = """<html><head><title>T</title><meta property="og:site_name" content="Example News">
        <meta property="article:published_time" content="2026-10-25T03:00:00Z"></head>
        <body><script>var x = "Typhoon Fake";</script><p>Typhoon Testa&nbsp;is here.</p></body></html>"""
        page = ts.html_to_text(html)
        self.assertNotIn("Fake", page["text"])
        self.assertIn("Typhoon Testa is here.", page["text"])
        self.assertEqual(page["site"], "Example News")
        self.assertEqual(page["published"], "2026-10-25T03:00:00Z")

    def test_typhoon_from_url_end_to_end(self):
        html = "<html><body><p>" + BULLETIN_TEXT.replace("\n", "</p><p>") + "</p></body></html>"
        result = ts.typhoon_from_url(
            "https://news.example/story",
            fetch=lambda url: (url, html),
            geocode=fake_geocode,
        )
        self.assertTrue(result["found"])
        self.assertEqual(result["position"]["latitude"], 13.6)
        self.assertIn("Unverified", result["note"])


try:
    from fastapi.testclient import TestClient
    from app.main import app
    HAVE_API = True
except ImportError:  # pragma: no cover
    HAVE_API = False


@unittest.skipUnless(HAVE_API, "fastapi/httpx not installed")
class TyphoonRouteTests(unittest.TestCase):
    def test_local_address_is_400(self):
        client = TestClient(app)
        response = client.get("/api/typhoon/from-url", params={"url": "http://127.0.0.1/secret"})
        self.assertEqual(response.status_code, 400)

    def test_bad_scheme_is_400(self):
        client = TestClient(app)
        response = client.get("/api/typhoon/from-url", params={"url": "file:///etc/hosts"})
        self.assertEqual(response.status_code, 400)
