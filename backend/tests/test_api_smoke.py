"""
API smoke tests. They need the packages in requirements-dev.txt
(fastapi + httpx) and are skipped automatically when those are missing.
Nothing here calls an external service.
"""

import unittest

try:
    from fastapi.testclient import TestClient
    from app.main import app

    HAVE_API = True
except ImportError:  # pragma: no cover - depends on the environment
    HAVE_API = False


@unittest.skipUnless(HAVE_API, "fastapi/httpx not installed")
class ApiSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def test_root(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["system"], "AGOS API")

    def test_unknown_municipality_is_404(self):
        response = self.client.get("/weather", params={"municipality": "Atlantis"})
        self.assertEqual(response.status_code, 404)

    def test_forecast_requires_a_date(self):
        response = self.client.get("/weather/forecast-grid")
        self.assertEqual(response.status_code, 422)

    def test_system_status_never_leaks_the_api_key(self):
        response = self.client.get("/system/status")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertIn("scheduler", body)
        self.assertIn("weatherapi_key_configured", body)
        self.assertNotIn("WEATHERAPI_API_KEY", response.text)

    def test_community_report_requires_fields(self):
        response = self.client.post("/reports/community", data={})
        self.assertEqual(response.status_code, 422)


@unittest.skipUnless(HAVE_API, "fastapi/httpx not installed")
class InterfaceApiTests(unittest.TestCase):
    """Routes for the redesigned interface (no external calls needed)."""

    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def test_municipalities_list(self):
        body = self.client.get("/api/municipalities").json()
        self.assertEqual(body["count"], 12)
        self.assertIn("latitude", body["municipalities"][0])

    def test_evacuation_centers_are_unverified(self):
        response = self.client.get("/api/evacuation-centers")
        self.assertEqual(response.status_code, 200)
        for center in response.json()["centers"]:
            self.assertEqual(center["verification"], "unverified")

    def test_unknown_municipality_detail_is_404(self):
        self.assertEqual(self.client.get("/api/municipalities/Atlantis").status_code, 404)

    def test_overview_hours_are_validated(self):
        self.assertEqual(self.client.get("/api/overview", params={"hours": 99}).status_code, 422)


if __name__ == "__main__":
    unittest.main()
