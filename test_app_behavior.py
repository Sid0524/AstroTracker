"""Backend behaviour the UI relies on (see docs/TESTING.md)."""

import importlib.util
import io
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from astropy.io import fits
from astropy.table import Table

import app
from test_app import record, synthetic_cutout
from test_s3 import DEC, RA, detector_file, open_local


class InputAndRoutingTests(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()
        app.searches.clear()
        app.frames.clear()

    def test_home_page_serves_the_viewer_with_the_timeline(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'id="coverage"', response.data)
        self.assertIn(b"timeline.js", response.data)
        response.close()

    def test_non_numeric_coordinates_are_rejected_with_a_clear_message(self):
        response = self.client.get("/api/search?ra=abc&dec=0&fov=3")
        self.assertEqual(response.status_code, 400)
        self.assertIn("RA must be a number", response.json["error"])

    def test_deep_flag_must_be_0_or_1(self):
        response = self.client.get("/api/search?ra=1&dec=0&fov=3&deep=yes")
        self.assertEqual(response.status_code, 400)
        self.assertIn("Deep survey", response.json["error"])

    def test_archive_busy_is_a_retryable_503_not_a_hang(self):
        held = [app.archive_slots.acquire() for _ in range(3)]
        try:
            with patch.object(app.archive_slots, "acquire", return_value=False), \
                    self.assertRaises(app.ViewerError) as caught:
                app.archive_get("https://irsa.ipac.caltech.edu/SIA?x", 10)
            self.assertEqual(caught.exception.status, 503)
            self.assertIn("busy", str(caught.exception))
        finally:
            for _ in held:
                app.archive_slots.release()


class CacheBoundTests(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()
        app.searches.clear()
        app.frames.clear()

    @patch("app.query_collection", return_value=([], False, 0))
    def test_only_the_8_most_recent_searches_are_kept(self, query):
        tokens = [self.client.get("/api/search?ra=1&dec=0&fov=3&release=dr1").json["search_id"]
                  for _ in range(9)]
        self.assertEqual(len(app.searches), 8)
        self.assertNotIn(tokens[0], app.searches, "oldest search is evicted")
        self.assertEqual(self.client.get(f"/api/frame/{tokens[0]}/0").status_code, 410)

    def test_frame_cache_is_bounded(self):
        records = []
        for i in range(app.FRAME_CACHE + 2):
            r = record()
            r["url"] = r["url"].replace("example", f"example{i}")
            r["cutout_url"] = app.cutout_url(r["url"], 269.4521, 4.6934, 0.05)
            records.append(r)
        app.searches["t"] = {"created": time.monotonic(), "records": records,
                             "ra": 269.4521, "dec": 4.6934, "fov": 0.05}
        with patch("app.archive_get", return_value=synthetic_cutout()):
            for i in range(len(records)):
                self.assertEqual(self.client.get(f"/api/frame/t/{i}").status_code, 200)
        self.assertEqual(len(app.frames), app.FRAME_CACHE)
        self.assertNotIn(("t", "0"), app.frames)


class ImageEdgeTests(unittest.TestCase):
    def test_one_dimensional_image_is_reported_as_unusable(self):
        hdus = fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(np.ones(10), name="IMAGE"),
                             fits.ImageHDU(np.zeros(10, dtype="i4"), name="FLAGS")])
        output = io.BytesIO()
        hdus.writeto(output)
        with self.assertRaises(app.ViewerError) as caught:
            app.render_cutout(output.getvalue(), 1, 2, 0.05)
        self.assertEqual(caught.exception.status, 422)

    def test_target_outside_footprint_has_no_wavelength(self):
        # Field center sits off the image, but part of the field overlaps it.
        frame = app.render_cutout(synthetic_cutout(), 269.4521 + 0.09, 4.6934, 0.25)
        self.assertFalse(frame["center_covered"])
        self.assertIsNone(frame["wavelength_um"])
        self.assertLess(frame["coverage"], 100)

    def test_non_numeric_time_row_is_skipped(self):
        row = Table({"t_min": ["soon"], "energy_bandpassname": ["SPHEREx-D1"], "em_min": [1.0],
                     "em_max": [2.0], "obs_id": ["x"]})[0]
        self.assertIsNone(app.parse_row(row, "u", "spherex_dr1"))


class S3EdgeTests(unittest.TestCase):
    def test_s3_busy_falls_back_to_irsa(self):
        with patch.object(app.s3_slots, "acquire", return_value=False), \
                patch("app.archive_get", return_value=b"irsa") as irsa, \
                self.assertLogs(app.app.logger, level="WARNING"):
            raw, source = app.fetch_cutout({"s3_url": "https://x", "cutout_url": "c"}, RA, DEC, 0.05)
        self.assertEqual((raw, source), (b"irsa", "irsa"))
        irsa.assert_called_once()

    def test_unmappable_field_corners_fall_back_to_irsa(self):
        with patch("app.fits.open", open_local(detector_file())), \
                patch("app.WCS.all_world2pix", return_value=(np.array([np.nan] * 5), np.zeros(5))), \
                patch("app.archive_get", return_value=b"irsa"), \
                self.assertLogs(app.app.logger, level="WARNING"):
            self.assertEqual(app.fetch_cutout({"s3_url": "https://x", "cutout_url": "c"}, RA, DEC, 0.05)[1],
                             "irsa")

    def test_files_without_a_wavelength_wcs_still_read(self):
        raw = detector_file()
        with fits.open(io.BytesIO(raw)) as hdus:
            for key in [k for k in hdus["IMAGE"].header if k.endswith("W")]:
                del hdus["IMAGE"].header[key]
            output = io.BytesIO()
            hdus.writeto(output)
        with patch("app.fits.open", open_local(output.getvalue())):
            partial = app.s3_cutout("https://x", RA, DEC, 0.05)
        with fits.open(io.BytesIO(partial)) as hdus:
            self.assertNotIn("CRPIX1W", hdus["IMAGE"].header)

    def test_without_fsspec_the_app_still_starts_and_uses_irsa_only(self):
        spec = importlib.util.spec_from_file_location("app_without_fsspec", Path(app.__file__))
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"fsspec": None}):
            spec.loader.exec_module(module)
        self.assertIsNone(module.S3_OPTIONS)


if __name__ == "__main__":
    unittest.main()


class WordingTests(unittest.TestCase):
    def test_collection_status_uses_singular_for_one(self):
        self.assertEqual(app.collection_status([{}], False, 0, None), ("ok", "1 exposure."))
        self.assertIn("1 malformed row skipped", app.collection_status([{}], False, 1, None)[1])
        self.assertIn("all 1 returned row was unreadable", app.collection_status([], False, 1, None)[1])
