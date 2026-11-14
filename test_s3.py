"""Tests for reading pixels from the public S3 copy, with IRSA fallback. Offline."""

import base64
import io
import json
import time
import unittest
from unittest.mock import patch

import numpy as np
from astropy.io import fits
from astropy.table import Table
from astropy.wcs import WCS

import app
from test_app import record

KEY = "qr3/level2/2026W33_2A/l2b-v27-2026-241/6/level2_2026W33_2A_0594_3D6_spx_l2b.fits"
RA, DEC = 269.4521, 4.6934


def detector_file(size=200):
    """A small full-detector file laid out like a SPHEREx level-2 image."""
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crval = [RA, DEC]
    wcs.wcs.crpix = [70, 120]  # target well away from the detector center
    angle = np.radians(35)
    wcs.wcs.cd = np.array([[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]]) * 0.0017
    header = wcs.to_header()
    header["BUNIT"] = "MJy/sr"
    for key, value in {"WCSAXESW": 2, "CTYPE1W": "WAVE", "CTYPE2W": "LINEAR", "CUNIT1W": "um",
                       "CUNIT2W": "um", "CRPIX1W": 1, "CRPIX2W": 1, "CRVAL1W": 0.75,
                       "CRVAL2W": 0.02, "CDELT1W": 0.001, "CDELT2W": 0.0001}.items():
        header[key] = value
    yy, xx = np.indices((size, size))
    data = (2 + 50 * np.exp(-((xx - 69) ** 2 + (yy - 119) ** 2) / 8) + 0.01 * xx).astype("f4")
    flags = np.zeros((size, size), dtype="i4")
    flags[100:140, 50:90] = 1
    hdus = fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(data, header, name="IMAGE"),
                         fits.CompImageHDU(flags, name="FLAGS"),
                         fits.BinTableHDU(Table({"x": [1]}), name="WCS-WAVE")])
    output = io.BytesIO()
    hdus.writeto(output)
    return output.getvalue()


def open_local(raw):
    real_open = fits.open
    return lambda url, **kwargs: real_open(io.BytesIO(raw))


def sia_row(cloud):
    table = Table({"cloud_access": [cloud]})
    return table[0]


class S3UrlTests(unittest.TestCase):
    def test_valid_cloud_access_maps_to_public_https_url(self):
        cloud = json.dumps({"aws": {"bucket_name": "nasa-irsa-spherex", "key": KEY, "region": "us-east-1"}})
        self.assertEqual(app.s3_url(sia_row(cloud)), app.S3_BASE + KEY)

    def test_unexpected_or_unsafe_locations_are_ignored(self):
        for cloud in (json.dumps({"aws": {"bucket_name": "evil-bucket", "key": KEY}}),
                      json.dumps({"aws": {"bucket_name": "nasa-irsa-spherex", "key": "qr3/level2/../x.fits"}}),
                      json.dumps({"aws": {"bucket_name": "nasa-irsa-spherex", "key": "qr2/level2/a.fits"}}),
                      json.dumps({"gcp": {}}), "not json", ""):
            with self.subTest(cloud=cloud):
                self.assertIsNone(app.s3_url(sia_row(cloud)))

    def test_missing_column_means_no_s3_copy(self):
        self.assertIsNone(app.s3_url(Table({"other": [1]})[0]))


class S3CutoutTests(unittest.TestCase):
    def test_partial_read_renders_identically_to_the_full_file(self):
        raw = detector_file()
        with patch("app.fits.open", open_local(raw)):
            partial = app.s3_cutout("https://example/x.fits", RA, DEC, 0.05)
        with fits.open(io.BytesIO(partial)) as hdus:
            self.assertLess(hdus["IMAGE"].data.shape[0], 200, "only a sub-image should be read")
        a = app.render_cutout(partial, RA, DEC, 0.05)
        b = app.render_cutout(raw, RA, DEC, 0.05)
        pa, pb = (np.frombuffer(base64.b64decode(f["pixels"]), "<f4") for f in (a, b))
        np.testing.assert_array_equal(pa, pb)
        self.assertAlmostEqual(a["wavelength_um"], b["wavelength_um"], places=9)
        self.assertEqual(a["coverage"], b["coverage"])
        self.assertTrue(a["center_covered"])

    def test_field_off_the_detector_is_422_not_a_fallback(self):
        with patch("app.fits.open", open_local(detector_file())), \
                self.assertRaises(app.ViewerError) as caught:
            app.s3_cutout("https://example/x.fits", RA + 5, DEC, 0.05)
        self.assertEqual(caught.exception.status, 422)


class FallbackTests(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()
        app.searches.clear()
        app.frames.clear()
        r = record()
        r["s3_url"] = app.S3_BASE + KEY
        r["cutout_url"] = app.cutout_url(r["url"], RA, DEC, 0.05)
        app.searches["t"] = {"created": time.monotonic(), "records": [r], "ra": RA, "dec": DEC, "fov": 0.05}
        self.record = r

    def test_s3_success_is_used_and_labelled(self):
        with patch("app.fits.open", open_local(detector_file())), patch("app.archive_get") as irsa:
            response = self.client.get("/api/frame/t/0")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["source"], "s3")
        irsa.assert_not_called()

    def test_s3_failure_falls_back_to_irsa_cutout(self):
        for error in (OSError("connection reset"), TimeoutError("slow"), KeyError("FLAGS")):
            with self.subTest(error=type(error).__name__):
                app.frames.clear()
                with patch("app.s3_cutout", side_effect=error), \
                        patch("app.archive_get", return_value=detector_file()) as irsa, \
                        self.assertLogs(app.app.logger, level="WARNING"):
                    response = self.client.get("/api/frame/t/0")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json["source"], "irsa")
                irsa.assert_called_once()

    def test_off_detector_does_not_waste_an_irsa_request(self):
        with patch("app.s3_cutout", side_effect=app.ViewerError("no cutout", 422)), \
                patch("app.archive_get") as irsa:
            self.assertEqual(self.client.get("/api/frame/t/0").status_code, 422)
        irsa.assert_not_called()

    def test_without_fsspec_or_cloud_copy_irsa_is_used(self):
        with patch("app.S3_OPTIONS", None), patch("app.archive_get", return_value=detector_file()):
            self.assertEqual(self.client.get("/api/frame/t/0").json["source"], "irsa")
        app.frames.clear()
        self.record["s3_url"] = None
        with patch("app.archive_get", return_value=detector_file()):
            self.assertEqual(self.client.get("/api/frame/t/0").json["source"], "irsa")

    def test_search_does_not_expose_internal_urls(self):
        r = dict(self.record)
        with patch("app.query_collection", return_value=([r], False, 0)):
            body = self.client.get(f"/api/search?ra={RA}&dec={DEC}&fov=3&release=dr1").json
        self.assertNotIn("s3_url", body["records"][0])
        self.assertNotIn("url", body["records"][0])


if __name__ == "__main__":
    unittest.main()
