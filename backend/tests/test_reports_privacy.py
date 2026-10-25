"""The public reports API must never expose a reporter's contact number."""

import unittest

try:
    from app.routes.reports import _public_report

    HAVE_FASTAPI = True
except ImportError:  # pragma: no cover - fastapi missing in this environment
    HAVE_FASTAPI = False


@unittest.skipUnless(HAVE_FASTAPI, "fastapi not installed")
class PublicReportTests(unittest.TestCase):
    def test_contact_and_file_name_are_removed(self):
        report = {"report_id": "AGOS-1", "contact_number": "09171234567", "photo_filename": "AGOS-1.jpg", "severity": "low"}
        public = _public_report(report)
        self.assertNotIn("contact_number", public)
        self.assertNotIn("photo_filename", public)
        self.assertTrue(public["has_contact"])
        self.assertEqual(public["severity"], "low")

    def test_no_contact(self):
        self.assertFalse(_public_report({"report_id": "x"})["has_contact"])


if __name__ == "__main__":
    unittest.main()
