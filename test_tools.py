"""Offline tests for the verification and benchmark tools."""

import base64
import contextlib
import io
import json
import logging
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError, URLError

import numpy as np

import app

sys.path.insert(0, str(Path(__file__).resolve().parent / "tools"))
import retry_benchmark as bench  # noqa: E402
import verify_releases as vr  # noqa: E402


def frame(size=128, peak=None, value=1.0):
    pixels = np.random.default_rng(0).normal(value, 0.01, (size, size)).astype("<f4")
    if peak:
        pixels[peak] = 50
    return {"size": size, "pixels": base64.b64encode(pixels.tobytes()).decode(), "coverage": 100.0,
            "center_covered": True, "wavelength_um": 4.9, "flagged_percent": 3.0}


def rows(collection, mjds, band="SPHEREx-D1"):
    return [{"collection": collection, "band": band, "mjd": m, "date": vr.day(m) + "T00:00:00Z",
             "observation": f"{collection}-{i}", "url": "u"} for i, m in enumerate(mjds)]


class AstrometryTests(unittest.TestCase):
    def test_barnard_propagates_to_the_viewers_2026_center(self):
        ra, dec = vr.propagate(vr.TARGETS["barnard"]["motion"], 61041.0)  # 2026.0
        self.assertAlmostEqual(ra, 269.446268, places=4)
        self.assertAlmostEqual(dec, 4.768204, places=4)

    def test_wise_0855_challenge_position_is_about_2_arcmin_from_the_object_in_2026(self):
        east, north = vr.offset_arcsec(vr.TARGETS["wise0855_ref"]["center"],
                                       vr.TARGETS["wise0855_2026"]["center"])
        self.assertGreater(-east, 120, "object is >120 arcsec west")
        self.assertGreater(-east, 90, "outside a 3 arcmin field's 90 arcsec half-width")
        self.assertLess(abs(north), 15)

    def test_offsets_wrap_across_ra_zero(self):
        east, _ = vr.offset_arcsec((359.999, 0), (0.001, 0))
        self.assertAlmostEqual(east, 7.2, places=3)

    def test_survey_windows_split_on_gaps_over_30_days(self):
        self.assertEqual([len(w) for w in vr.survey_windows([1, 5, 40, 41, 300])], [2, 2, 1])
        self.assertEqual(vr.survey_windows([]), [])
        self.assertEqual(vr.day(60914.2), "2025-08-27")


class QueryTests(unittest.TestCase):
    def test_failed_collections_are_retried_then_reported_with_attempt_count(self):
        outcomes = {"spherex_dr1": [app.ViewerError("down"), (rows("spherex_dr1", [60914]), False, 0)],
                    "spherex_qr3": [app.ViewerError("down")] * 3}

        def query(collection, *args):
            result = outcomes[collection].pop(0) if len(outcomes[collection]) > 1 else outcomes[collection][0]
            if isinstance(result, Exception):
                raise result
            return result

        with patch("app.query_collection", side_effect=query), patch("verify_releases.time.sleep"), \
                contextlib.redirect_stderr(io.StringIO()):
            results = vr.query(vr.TARGETS["barnard"], 3, deep=False, retries=2)
        self.assertEqual(set(results), {"spherex_dr1", "spherex_qr3"}, "deep collections only with --deep")
        self.assertEqual((results["spherex_dr1"]["status"], results["spherex_dr1"]["failed_attempts"]), ("ok", 1))
        self.assertEqual((results["spherex_qr3"]["status"], results["spherex_qr3"]["failed_attempts"]), ("failed", 2))


class DetectionTests(unittest.TestCase):
    target = {"center": (10.0, 0.0), "motion": {"ra": 10.0, "dec": 0.0, "epoch_mjd": 60000, "pmra": 0, "pmdec": 0}}

    def test_a_source_at_the_predicted_position_has_high_snr(self):
        result = vr.detection(frame(peak=(64, 64)), self.target, {"mjd": 60000}, 3)
        self.assertTrue(result["inside_field"])
        self.assertTrue(result["finite_at_target"])
        self.assertGreater(result["peak_snr"], 100)

    def test_a_target_outside_the_field_is_flagged_not_measured(self):
        far = dict(self.target, motion=dict(self.target["motion"], ra=10.1))
        result = vr.detection(frame(), far, {"mjd": 60000}, 3)
        self.assertFalse(result["inside_field"])
        self.assertNotIn("peak_snr", result)

    def test_no_finite_pixels_near_the_target_is_reported(self):
        f = frame()
        pixels = np.frombuffer(base64.b64decode(f["pixels"]), "<f4").copy().reshape(128, 128)
        pixels[50:80, 50:80] = np.nan
        f["pixels"] = base64.b64encode(pixels.tobytes()).decode()
        result = vr.detection(f, self.target, {"mjd": 60000}, 3)
        self.assertFalse(result["finite_at_target"])


class ReportTests(unittest.TestCase):
    def results(self):
        return {"spherex_dr1": {"status": "ok", "message": "", "failed_attempts": 1,
                                "rows": rows("spherex_dr1", [60914, 60915, 61100])},
                "spherex_qr3": {"status": "failed", "message": "IRSA down", "rows": []}}

    def test_spot_checks_cover_first_and_last_per_collection_and_band_and_keep_errors(self):
        results = {"spherex_dr1": {"rows": rows("spherex_dr1", [60914, 61100]) + rows("spherex_dr1", [60920], "SPHEREx-D6")}}
        renders = iter([frame(peak=(64, 64)), app.ViewerError("cutout failed"), frame()])
        with patch("app.cutout_url", return_value="c"), patch("app.archive_get", return_value=b""), \
                patch("app.render_cutout", side_effect=lambda *a: (lambda r: (_ for _ in ()).throw(r) if isinstance(r, Exception) else r)(next(renders))):
            checks = vr.spot_checks(vr.TARGETS["barnard"], results, 3, ["SPHEREx-D1", "SPHEREx-D6"])
        self.assertEqual(len(checks), 3, "first+last D1, single D6")
        self.assertIn("error", checks[1])
        self.assertIn("peak_snr", checks[0])

    def test_report_shows_status_windows_detectors_overlap_and_checks(self):
        results = self.results()
        results["spherex_qr3"]["rows"] = rows("spherex_qr3", [61270])
        results["spherex_qr3"]["rows"][0]["observation"] = "spherex_dr1-0"  # shared ID
        checks = [{"collection": "spherex_dr1", "band": "SPHEREx-D1", "date": "2025-08-27", "coverage": 100.0,
                   "predicted_offset_arcsec": [1.0, 2.0], "inside_field": True, "peak_snr": 9.0,
                   "wavelength_um": 0.75, "flagged_percent": 5.0},
                  {"collection": "spherex_dr1", "band": "SPHEREx-D6", "date": "2025-08-27", "coverage": 50.0,
                   "predicted_offset_arcsec": [200.0, 2.0], "inside_field": False, "wavelength_um": None,
                   "flagged_percent": 1.0},
                  {"collection": "spherex_dr1", "band": "SPHEREx-D6", "date": "2025-08-28", "error": "boom"}]
        text = vr.report("barnard", vr.TARGETS["barnard"], results, checks, 3)
        self.assertIn("ok (after 1 failed attempt(s))", text)
        self.assertIn("_IRSA down_", text)
        self.assertIn("2025-08-27..2025-08-28 (2); 2026-03-01..2026-03-01 (1)", text)
        self.assertIn("| D1 | 3 on 3 dates | 1 on 1 date |", text)
        self.assertIn("DR1/QR3 overlap: 1 observation IDs (obs_id", text)
        self.assertIn("| NO |", text)
        self.assertIn("error: boom", text)

    def test_main_prints_markdown_and_saves_json(self):
        with tempfile.TemporaryDirectory() as tmp, \
                patch("verify_releases.query", return_value=self.results()), \
                patch("verify_releases.spot_checks", return_value=[]) as checks, \
                patch.object(sys, "argv", ["verify", "--targets", "barnard", "--no-cutouts", "--json", f"{tmp}/o.json"]), \
                contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()):
            vr.main()
            saved = json.loads(Path(f"{tmp}/o.json").read_text())
        checks.assert_not_called()
        self.assertIn("## Live verification run", out.getvalue())
        self.assertEqual(saved["barnard"]["collections"]["spherex_qr3"]["status"], "failed")


class RetryBenchmarkTests(unittest.TestCase):
    def setUp(self):
        bench.log.clear()
        self.saved = (app.urlopen, app.archive_get)

    def tearDown(self):
        app.urlopen, app.archive_get = self.saved
        logging.disable(logging.NOTSET)  # bench.main() silences warnings globally
        app.searches.clear()
        app.frames.clear()

    def test_percentiles_and_empty_summary(self):
        self.assertEqual(bench.pct([5, 1, 3], 0.5), 3)
        self.assertTrue(np.isnan(bench.pct([], 0.5)))
        self.assertEqual(bench.summarize("cutout"), "cutout: no requests")

    def test_summary_counts_first_try_success_rescues_and_failure_codes(self):
        bench.log.extend([
            {"kind": "metadata", "ok": True, "seconds": 1.0, "attempts": [{"outcome": "ok"}]},
            {"kind": "metadata", "ok": True, "seconds": 6.0, "attempts": [{"outcome": "HTTP 503"}, {"outcome": "ok"}]},
            {"kind": "metadata", "ok": False, "seconds": 9.0, "attempts": [{"outcome": "HTTP 503"}] * 3},
        ])
        text = bench.summarize("metadata")
        self.assertIn("first-try success 1/3 (33%)", text)
        self.assertIn("final success 2/3 (67%)", text)
        self.assertIn("retried 2, rescued by retry 1", text)
        self.assertIn("'HTTP 503': 4", text)

    def test_wrappers_record_every_attempt_and_outcome(self):
        bench.CURRENT[0] = "T"

        def real(request, timeout=None):
            raise {"a": HTTPError("u", 503, "busy", {}, None), "b": URLError("dns")}[request]

        with patch("retry_benchmark.real_urlopen", side_effect=real):
            bench.local.attempts = []
            for request, error in (("a", HTTPError), ("b", URLError)):
                with self.assertRaises(error):
                    bench.urlopen(request)
        self.assertEqual([a["outcome"] for a in bench.local.attempts], ["HTTP 503", "URLError"])
        with patch("retry_benchmark.real_archive_get", side_effect=app.ViewerError("x")), \
                self.assertRaises(app.ViewerError):
            bench.archive_get("https://irsa.ipac.caltech.edu/SIA?COLLECTION=spherex_dr1&POS=x", 10)
        self.assertEqual(bench.log[-1]["collection"], "spherex_dr1")
        self.assertFalse(bench.log[-1]["ok"])

    def test_main_runs_searches_and_cutouts_through_the_real_endpoints(self):
        from test_data_quality import FakeResponse, sia_rows, votable
        from test_app import synthetic_cutout

        def real(request, timeout=None):
            url = request.full_url
            if "COLLECTION=spherex_qr3" in url:
                raise HTTPError(url, 503, "busy", {}, None)
            if "/SIA?" in url:
                return FakeResponse(votable(sia_rows(2)))
            return FakeResponse(synthetic_cutout())

        with tempfile.TemporaryDirectory() as tmp, \
                patch("retry_benchmark.real_urlopen", side_effect=real), patch("app.time.sleep"), \
                patch("app.S3_OPTIONS", None), patch.object(bench, "TARGETS", [("Barnard", 269.4521, 4.6934)]), \
                patch.object(sys, "argv", ["bench", "--json", f"{tmp}/b.json"]), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            bench.main()
            saved = json.loads(Path(f"{tmp}/b.json").read_text())
        text = out.getvalue()
        self.assertIn("| Barnard | 200 | dr1=ok, qr3=failed | 2 |", text)
        self.assertIn("100.0%, irsa", text)
        self.assertIn("metadata: 2 requests | first-try success 1/2", text)
        self.assertEqual(len(saved), 3, "two searches and one cutout recorded")


if __name__ == "__main__":
    unittest.main()
