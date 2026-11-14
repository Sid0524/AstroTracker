"""Empty, partial and failed IRSA responses, through the real request path."""

import io
import time
import unittest
from http.client import IncompleteRead
from unittest.mock import patch
from urllib.error import HTTPError, URLError

import numpy as np
from astropy.io import fits
from astropy.io.votable import from_table, writeto
from astropy.table import MaskedColumn, Table

import app
from test_app import record, synthetic_cutout

DR1_URL = "https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/2025W35_1A/l2b-{}.fits"
QR3_URL = "https://irsa.ipac.caltech.edu/ibe/data/spherex/qr3/level2/2026W10_1A/l2b-{}.fits"


def sia_rows(n=3, url=DR1_URL, start=60914.2, band="SPHEREx-D1"):
    return [{"access_url": url.format(i), "t_min": start + i, "obs_id": f"obs{i}",
             "energy_bandpassname": band, "em_min": 0.75e-6, "em_max": 1.09e-6}
            for i in range(n)]


def votable(rows, query_status=None, drop=()):
    """Build an IRSA-like SIA VOTable, optionally with a QUERY_STATUS INFO."""
    columns = ["access_url", "t_min", "obs_id", "energy_bandpassname", "em_min", "em_max"]
    table = Table()
    for name in columns:
        if name in drop:
            continue
        values = [row[name] for row in rows]
        if name in ("t_min", "em_min", "em_max"):
            mask = [v is None for v in values]
            table[name] = MaskedColumn([np.nan if v is None else v for v in values],
                                       mask=mask, dtype=float)
        else:
            table[name] = [str(v) for v in values] if values else np.array([], dtype=str)
    output = io.BytesIO()
    writeto(from_table(table), output)
    xml = output.getvalue()
    if query_status:
        info = f'<INFO name="QUERY_STATUS" value="{query_status}"/>'.encode()
        xml = xml.replace(b'<RESOURCE type="results">', b'<RESOURCE type="results">' + info, 1)
    return xml


class FakeResponse:
    def __init__(self, body=b"", cut_off=False):
        self.body = body
        self.cut_off = cut_off

    def read(self, limit=-1):
        if self.cut_off:
            raise IncompleteRead(self.body[: len(self.body) // 2], len(self.body))
        return self.body if limit < 0 else self.body[:limit]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def fake_irsa(by_collection, cutout=None):
    """Route fake urlopen calls by SIA collection; each value is a list of
    outcomes consumed per call (bytes, FakeResponse, or an exception)."""
    calls = {key: list(value) for key, value in by_collection.items()}

    def urlopen(request, timeout=None):
        url = request.full_url
        if "/SIA?" in url:
            collection = url.split("COLLECTION=")[1].split("&")[0]
            outcome = calls[collection].pop(0) if len(calls[collection]) > 1 else calls[collection][0]
        else:
            outcome = cutout.pop(0) if len(cutout) > 1 else cutout[0]
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome if isinstance(outcome, FakeResponse) else FakeResponse(outcome)

    return urlopen


def http_error(code):
    return HTTPError("https://irsa.ipac.caltech.edu/SIA", code, "error", {}, None)


@patch("app.time.sleep")
class EmptyResponseTests(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()
        app.searches.clear()
        app.frames.clear()

    def search(self, release="both"):
        return self.client.get(f"/api/search?ra=269.446268&dec=4.768204&fov=3&release={release}")

    def test_zero_row_votable_is_reported_as_empty_not_failed(self, sleep):
        empty = votable([], query_status="OK")
        with patch("app.urlopen", fake_irsa({"spherex_dr1": [empty], "spherex_qr3": [empty]})):
            response = self.search()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["records"], [])
        self.assertEqual(response.json["warnings"], [])
        self.assertEqual([s["status"] for s in response.json["collection_status"]], ["empty", "empty"])

    def test_one_release_empty_other_has_data(self, sleep):
        with patch("app.urlopen", fake_irsa({"spherex_dr1": [votable(sia_rows(4))],
                                             "spherex_qr3": [votable([])]})):
            response = self.search()
        statuses = {s["collection"]: s for s in response.json["collection_status"]}
        self.assertEqual(statuses["spherex_dr1"]["status"], "ok")
        self.assertEqual(statuses["spherex_dr1"]["count"], 4)
        self.assertEqual(statuses["spherex_qr3"]["status"], "empty")
        self.assertEqual(response.json["warnings"], [])
        self.assertEqual({r["release"] for r in response.json["records"]}, {"DR1"})

    def test_empty_http_body_is_a_failure_not_empty_coverage(self, sleep):
        with patch("app.urlopen", fake_irsa({"spherex_dr1": [b""], "spherex_qr3": [votable([])]})), \
                self.assertLogs(app.app.logger, level="ERROR"):
            response = self.search()
        self.assertEqual(response.status_code, 200)
        statuses = {s["collection"]: s["status"] for s in response.json["collection_status"]}
        self.assertEqual(statuses, {"spherex_dr1": "failed", "spherex_qr3": "empty"})
        self.assertIn("unknown", response.json["warnings"][0])

    def test_single_release_search_only_queries_that_release(self, sleep):
        with patch("app.urlopen", fake_irsa({"spherex_qr3": [votable([])]})):
            response = self.search("qr3")
        self.assertEqual(response.json["collections"], ["spherex_qr3"])
        self.assertEqual(response.json["collection_status"][0]["status"], "empty")


@patch("app.time.sleep")
class PartialResponseTests(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()
        app.searches.clear()

    def test_malformed_rows_are_skipped_and_counted(self, sleep):
        rows = sia_rows(5)
        rows[1]["t_min"] = None                        # masked time
        rows[2]["energy_bandpassname"] = "SPHEREx-D9"  # unknown detector
        rows[3]["em_min"] = None                       # masked wavelength
        with self.assertLogs(app.app.logger, level="WARNING"):
            records, truncated, skipped = app.parse_records(votable(rows), "spherex_dr1")
        self.assertEqual([r["observation"] for r in records], ["obs0", "obs4"])
        self.assertFalse(truncated)
        self.assertEqual(skipped, 3)

    def test_partial_collection_is_flagged_in_search(self, sleep):
        rows = sia_rows(3)
        rows[0]["t_min"] = None
        with patch("app.urlopen", fake_irsa({"spherex_dr1": [votable(rows)],
                                             "spherex_qr3": [votable([])]})), \
                self.assertLogs(app.app.logger, level="WARNING"):
            response = self.client.get("/api/search?ra=269&dec=4&fov=3")
        dr1 = response.json["collection_status"][0]
        self.assertEqual((dr1["status"], dr1["count"], dr1["skipped"]), ("partial", 2, 1))
        self.assertIn("incomplete", response.json["warnings"][0])

    def test_all_rows_malformed_means_unknown_coverage(self, sleep):
        rows = sia_rows(2)
        for row in rows:
            row["t_min"] = None
        with patch("app.urlopen", fake_irsa({"spherex_dr1": [votable(rows)]})), \
                self.assertLogs(app.app.logger, level="WARNING"):
            response = self.client.get("/api/search?ra=269&dec=4&fov=3&release=dr1")
        self.assertEqual(response.status_code, 502)
        self.assertIn("unknown", response.json["error"])

    def test_overflow_status_marks_truncation(self, sleep):
        records, truncated, _ = app.parse_records(
            votable(sia_rows(2), query_status="OVERFLOW"), "spherex_dr1")
        self.assertTrue(truncated)
        self.assertEqual(len(records), 2)

    def test_record_cap_marks_truncation_and_keeps_first_rows(self, sleep):
        with patch("app.MAX_RECORDS", 3):
            records, truncated, _ = app.parse_records(votable(sia_rows(5)), "spherex_dr1")
            self.assertEqual(app.collection_status(records, truncated, 0, None)[0], "truncated")
        self.assertTrue(truncated)
        self.assertEqual(len(records), 3)

    def test_duplicate_urls_are_merged_not_counted_as_malformed(self, sleep):
        rows = sia_rows(2)
        rows.append(dict(rows[0], obs_id="duplicate"))
        records, _, skipped = app.parse_records(votable(rows), "spherex_dr1")
        self.assertEqual(len(records), 2)
        self.assertEqual(skipped, 0)

    def test_votable_cut_off_mid_document_is_a_failure(self, sleep):
        body = votable(sia_rows(5))
        with self.assertLogs(app.app.logger, level="ERROR"), self.assertRaises(app.ViewerError):
            app.parse_records(body[: len(body) // 2], "spherex_dr1")

    def test_connection_dropped_mid_body_is_retried_then_reported(self, sleep):
        """Regression: IncompleteRead is not an OSError and used to escape as a 500."""
        cut = FakeResponse(votable(sia_rows(3)), cut_off=True)
        with patch("app.urlopen", fake_irsa({"spherex_dr1": [cut], "spherex_qr3": [votable([])]})), \
                self.assertLogs(app.app.logger, level="WARNING") as logs:
            response = self.client.get("/api/search?ra=269&dec=4&fov=3")
        self.assertEqual(response.status_code, 200)
        statuses = {s["collection"]: s["status"] for s in response.json["collection_status"]}
        self.assertEqual(statuses["spherex_dr1"], "failed")
        self.assertTrue(any("retry 1/" in line for line in logs.output))

    def test_dropped_connection_recovers_on_retry(self, sleep):
        body = votable(sia_rows(3))
        with patch("app.urlopen", fake_irsa({"spherex_dr1": [FakeResponse(body, cut_off=True), body]})), \
                self.assertLogs(app.app.logger, level="WARNING"):
            records, _, _ = app.query_collection("spherex_dr1", 269, 4, 0.05)
        self.assertEqual(len(records), 3)


@patch("app.time.sleep")
class FailedResponseTests(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()
        app.searches.clear()
        app.frames.clear()

    def query(self, outcomes):
        with patch("app.urlopen", fake_irsa({"spherex_dr1": outcomes})) as fetch:
            try:
                return app.query_collection("spherex_dr1", 269, 4, 0.05), fetch
            except app.ViewerError as exc:
                return exc, fetch

    def assert_fails(self, outcomes, text="IRSA"):
        with self.assertLogs(app.app.logger, level="WARNING"):
            result, _ = self.query(outcomes)
        self.assertIsInstance(result, app.ViewerError)
        self.assertIn(text, str(result))

    def test_http_500_is_not_retried(self, sleep):
        calls = []

        def urlopen(request, timeout=None):
            calls.append(request.full_url)
            raise http_error(500)

        with patch("app.urlopen", urlopen), self.assertLogs(app.app.logger, level="WARNING"), \
                self.assertRaises(app.ViewerError):
            app.query_collection("spherex_dr1", 269, 4, 0.05)
        self.assertEqual(len(calls), 1)
        sleep.assert_not_called()

    def test_transient_503_then_success_recovers(self, sleep):
        with self.assertLogs(app.app.logger, level="WARNING"):
            (records, _, _), _ = self.query([http_error(503), votable(sia_rows(2))])
        self.assertEqual(len(records), 2)

    def test_dns_failure_timeout_and_reset_are_failures(self, sleep):
        for error in (URLError("name resolution failed"), TimeoutError("timed out"),
                      ConnectionResetError("reset by peer")):
            with self.subTest(error=type(error).__name__):
                self.assert_fails([error])

    def test_query_status_error_is_a_failure(self, sleep):
        result, _ = self.query([votable([], query_status="ERROR")])
        self.assertIsInstance(result, app.ViewerError)
        self.assertIn("rejected", str(result))

    def test_html_maintenance_page_with_200_is_a_failure(self, sleep):
        with self.assertLogs(app.app.logger, level="ERROR"):
            result, _ = self.query([b"<html><body>IRSA is down for maintenance</body></html>"])
        self.assertIsInstance(result, app.ViewerError)

    def test_missing_required_columns_is_a_failure(self, sleep):
        result, _ = self.query([votable(sia_rows(2), drop=("t_min",))])
        self.assertIsInstance(result, app.ViewerError)
        self.assertIn("unrecognized", str(result))

    def test_oversized_metadata_is_refused(self, sleep):
        with patch("app.urlopen", fake_irsa({"spherex_dr1": [b"x" * 200]})), \
                self.assertRaises(app.ViewerError) as caught:
            app.archive_get("https://irsa.ipac.caltech.edu/SIA?COLLECTION=spherex_dr1&x", 100)
        self.assertIn("limit", str(caught.exception))

    def test_failed_and_empty_release_is_not_reported_as_no_coverage(self, sleep):
        with patch("app.urlopen", fake_irsa({"spherex_dr1": [votable([])],
                                             "spherex_qr3": [http_error(502)]})), \
                self.assertLogs(app.app.logger, level="WARNING"):
            response = self.client.get("/api/search?ra=133.795&dec=-7.245&fov=3")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["records"], [])
        statuses = {s["collection"]: s["status"] for s in response.json["collection_status"]}
        self.assertEqual(statuses, {"spherex_dr1": "empty", "spherex_qr3": "failed"})
        self.assertIn("spherex_qr3", response.json["warnings"][0])
        self.assertIn("unknown", response.json["warnings"][0])

    def test_total_outage_returns_json_502_with_each_collection(self, sleep):
        with patch("app.urlopen", fake_irsa({"spherex_dr1": [http_error(502)],
                                             "spherex_qr3": [URLError("down")]})), \
                self.assertLogs(app.app.logger, level="WARNING"):
            response = self.client.get("/api/search?ra=269&dec=4&fov=3")
        self.assertEqual(response.status_code, 502)
        self.assertTrue(response.is_json)
        self.assertIn("spherex_dr1", response.json["error"])
        self.assertIn("spherex_qr3", response.json["error"])

    # --- cutout (frame) failures -------------------------------------------

    def frame(self, cutout_outcomes):
        r = record()
        r["cutout_url"] = app.cutout_url(r["url"], 269.4521, 4.6934, 0.05)
        app.searches["t"] = {"created": time.monotonic(), "records": [r],
                             "ra": 269.4521, "dec": 4.6934, "fov": 0.05}
        with patch("app.urlopen", fake_irsa({}, cutout=list(cutout_outcomes))):
            return self.client.get("/api/frame/t/0")

    def test_cutout_outage_is_json_error_and_not_cached(self, sleep):
        with self.assertLogs(app.app.logger, level="WARNING"):
            response = self.frame([http_error(503)])
        self.assertEqual(response.status_code, 502)
        self.assertNotIn(("t", "0"), app.frames)
        self.assertEqual(self.frame([synthetic_cutout()]).status_code, 200)

    def test_truncated_or_non_fits_cutout_is_reported(self, sleep):
        for body in (synthetic_cutout()[:5000], b"<html>Service unavailable</html>"):
            with self.subTest(size=len(body)), self.assertLogs(app.app.logger, level="ERROR"):
                response = self.frame([body])
            self.assertEqual(response.status_code, 502)
            self.assertIn("could not be read", response.json["error"])
            self.assertNotIn(("t", "0"), app.frames)

    def test_cutout_with_no_finite_pixels_is_422(self, sleep):
        with fits.open(io.BytesIO(synthetic_cutout())) as hdus:
            hdus["IMAGE"].data[:] = np.nan
            output = io.BytesIO()
            hdus.writeto(output)
        response = self.frame([output.getvalue()])
        self.assertEqual(response.status_code, 422)

    def test_partially_covered_cutout_reports_coverage(self, sleep):
        with fits.open(io.BytesIO(synthetic_cutout())) as hdus:
            hdus["IMAGE"].data[:, :45] = np.nan
            output = io.BytesIO()
            hdus.writeto(output)
        response = self.frame([output.getvalue()])
        self.assertEqual(response.status_code, 200)
        self.assertLess(response.json["coverage"], 100)
        self.assertGreater(response.json["coverage"], 0)


if __name__ == "__main__":
    unittest.main()
