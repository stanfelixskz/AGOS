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


PLACES = {
    "Virac": (13.58, 124.23), "Morong": (14.68, 120.27), "Casiguran": (16.28, 122.12), "Aurora": (15.9, 121.6),
}


def fake_geocode(place):
    key = place.split(",")[0].strip()
    if key in PLACES:
        lat, lon = PLACES[key]
        return {"query": place, "name": key, "admin1": "Test", "country": "Philippines", "latitude": lat, "longitude": lon, "source": "test"}
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

    def test_place_name_stops_at_line_end_and_period(self):
        seen = []

        def geocode(place):
            seen.append(place)
            return fake_geocode(place)

        ts.extract_typhoon("Tropical Storm Testg was 180 km North Northeast of Virac, Catanduanes.\nSignal No. 2 is raised.", geocode=geocode)
        self.assertEqual(seen, ["Virac, Catanduanes"])

    def test_headline_storm_wins_over_sidebar_mentions(self):
        text = "Related: Severe Tropical Storm Testy left PAR. Typhoon Testz is 300 km east of Virac, Catanduanes."
        r = ts.extract_typhoon(text, geocode=fake_geocode, title="Testz rapidly intensifies")
        self.assertEqual(r["storm"]["name"], "Testz")
        self.assertEqual(ts.extract_typhoon(text, geocode=fake_geocode)["storm"]["name"], "Testy")

    def test_headline_name_without_category_is_used_and_category_not_guessed(self):
        text = ("Testv could make landfall tonight. Testv was 465 km east of Virac, Catanduanes. "
                "Testv has winds of 150 km/h. Earlier, Severe Tropical Storm Testu left the country.")
        r = ts.extract_typhoon(text, geocode=fake_geocode, title="Testv rapidly intensifies into typhoon")
        self.assertEqual(r["storm"]["name"], "Testv")
        self.assertIsNone(r["storm"]["category"])
        # A headline that starts with a generic word does not become a storm name.
        r2 = ts.extract_typhoon("Signal Signal Signal. Typhoon Testz nears.", geocode=fake_geocode, title="Signal No. 3 raised")
        self.assertEqual(r2["storm"]["name"], "Testz")

    def test_month_is_not_a_storm_name_and_hashtags_are_read(self):
        self.assertIsNone(ts.extract_typhoon("Tropical Storm Nov. 9 update: no storm.", geocode=fake_geocode)["storm"])
        r = ts.extract_typhoon("Super Typhoon #TestwPH nears land.", geocode=fake_geocode)
        self.assertEqual(r["storm"]["name"], "Testw")

    def test_city_suffix_is_retried_without_city(self):
        self.assertEqual(ts._name_variants("Borongan City"), ["Borongan City", "Borongan"])
        self.assertEqual(ts._name_variants("City of Borongan"), ["City of Borongan", "Borongan"])
        self.assertEqual(ts._name_variants("Virac"), ["Virac"])

    def test_nautical_miles_are_converted(self):
        r = ts.extract_typhoon("Typhoon Testa was 100 nautical miles east of Virac, Catanduanes.", geocode=fake_geocode)
        rel = r["position"]["relative"]
        self.assertEqual(rel["distance_km"], 185.2)
        self.assertEqual(rel["distance_stated"], "100 nautical miles")
        self.assertAlmostEqual(r["position"]["longitude"], 124.23 + 185.2 / 108, delta=0.05)

    def test_filipino_distance_phrase(self):
        r = ts.extract_typhoon("Ang bagyong Testa ay nasa 120 km silangan ng Virac, Catanduanes.", geocode=fake_geocode)
        self.assertEqual(r["position"]["method"], "relative")
        self.assertEqual(r["position"]["relative"]["bearing_deg"], 90)
        self.assertEqual(r["position"]["relative"]["distance_km"], 120)

    def test_over_coastal_waters_of_a_place(self):
        r = ts.extract_typhoon("Tropical Storm Testa was over the coastal waters of Morong, Bataan at 2 AM.", geocode=fake_geocode)
        p = r["position"]
        self.assertEqual(p["method"], "place")
        self.assertTrue(p["approximate"])
        self.assertEqual((p["latitude"], p["longitude"]), (14.68, 120.27))
        self.assertEqual(p["near"]["place"], "Morong, Bataan")

    def test_landfall_and_filipino_place_forms(self):
        for text in ("Typhoon Testa made landfall in Casiguran, Aurora early today.",
                     "Nag-landfall sa Casiguran, Aurora ang bagyong Testa."):
            p = ts.extract_typhoon(text, geocode=fake_geocode)["position"]
            self.assertEqual(p["method"], "place", text)
            self.assertEqual(p["latitude"], 16.28)

    def test_forecast_landfall_is_not_a_position(self):
        for text in ("Typhoon Testa may make landfall over Casiguran, Aurora tonight.",
                     "Typhoon Testa is expected to make landfall in Casiguran, Aurora.",
                     "Maaaring mag-landfall sa Casiguran, Aurora ang bagyong Testa.",
                     "Testa may exhibit a 'wobbling motion' while in the vicinity of Casiguran on Wednesday."):
            self.assertIsNone(ts.extract_typhoon(text, geocode=fake_geocode)["position"], text)

    def test_distance_beats_place_when_both_are_given(self):
        text = "Typhoon Testa made landfall in Casiguran, Aurora. It is now 135 km north of Virac, Catanduanes."
        self.assertEqual(ts.extract_typhoon(text, geocode=fake_geocode)["position"]["method"], "relative")

    def test_direction_without_distance_gives_an_area_not_a_position(self):
        r = ts.extract_typhoon("Tropical Storm Testa keeps strength over the Philippine Sea east of Aurora.", geocode=fake_geocode)
        self.assertIsNone(r["position"])
        self.assertEqual(r["area"]["bearing_deg"], 90)
        self.assertEqual(r["area"]["place"], "Aurora")
        self.assertEqual(r["area"]["geocode"]["latitude"], 15.9)
        self.assertIn("without a distance", r["position_note"])

    def test_open_sea_alone_is_not_a_place(self):
        r = ts.extract_typhoon("Tropical Storm Testa is over the Philippine Sea.", geocode=fake_geocode)
        self.assertIsNone(r["position"])
        self.assertIsNone(r["area"])

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
