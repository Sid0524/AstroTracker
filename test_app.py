import base64
import io
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

import numpy as np
from astropy.io import fits
from astropy.io.votable import from_table, writeto
from astropy.table import Table
from astropy.wcs import WCS

import app


def record(mjd=60914.2, release="dr1"):
    return {
        "url": f"https://irsa.ipac.caltech.edu/ibe/data/spherex/{release}/level2/2025W35_1A/example.fits",
        "mjd": mjd, "date": "2025-08-27T04:48:00Z", "observation": "example",
        "band": "SPHEREx-D1", "release": release.upper(),
        "collection": f"spherex_{release}", "range_um": [0.75, 1.1],
    }


def synthetic_cutout():
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crval = [269.4521, 4.6934]
    wcs.wcs.crpix = [51, 51]
    angle = np.radians(35)
    wcs.wcs.cd = np.array([[np.cos(angle), -np.sin(angle)],
                          [np.sin(angle), np.cos(angle)]]) * 0.001
    header = wcs.to_header()
    header["BUNIT"] = "MJy/sr"
    for key, value in {
        "WCSAXESW": 2, "CTYPE1W": "WAVE", "CTYPE2W": "LINEAR",
        "CUNIT1W": "um", "CUNIT2W": "um", "CRPIX1W": 51, "CRPIX2W": 51,
        "CRVAL1W": 1, "CRVAL2W": 0.025, "CDELT1W": 0.001, "CDELT2W": 0.0001,
    }.items():
        header[key] = value
    yy, xx = np.indices((101, 101))
    data = 2 + 50 * np.exp(-((xx - 50) ** 2 + (yy - 50) ** 2) / 8)
    hdus = fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(data, header=header, name="IMAGE"),
                         fits.ImageHDU(np.zeros_like(data, dtype="i4"), name="FLAGS")])
    output = io.BytesIO()
    hdus.writeto(output)
    return output.getvalue()


class ViewerTests(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()
        app.searches.clear()
        app.frames.clear()

    def test_input_validation_blocks_invalid_and_nonfinite_coordinates(self):
        for query in ("ra=360&dec=0&fov=3", "ra=-1&dec=0&fov=3",
                      "ra=nan&dec=0&fov=3", "ra=1&dec=inf&fov=3",
                      "ra=1&dec=91&fov=3", "ra=1&dec=0&fov=13",
                      "ra=1&dec=0&fov=3&release=qr2"):
            with self.subTest(query=query):
                self.assertEqual(self.client.get("/api/search?" + query).status_code, 400)

    @patch("app.query_collection", return_value=([], False, 0))
    def test_no_coverage_is_successful_empty_search(self, query):
        response = self.client.get("/api/search?ra=0&dec=90&fov=1")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["records"], [])
        self.assertEqual(response.json["warnings"], [])
        self.assertEqual(query.call_count, 2)

    @patch("app.query_collection")
    def test_partial_collection_failure_is_visible(self, query):
        def result(collection, *args):
            if collection.endswith("qr3"):
                raise app.ViewerError("Test outage")
            return [record()], False, 0
        query.side_effect = result
        response = self.client.get("/api/search?ra=269&dec=4&fov=3")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json["records"]), 1)
        self.assertIn("Test outage", response.json["warnings"][0])

    @patch("app.query_collection", side_effect=app.ViewerError("Test outage"))
    def test_total_archive_failure_is_not_no_coverage(self, query):
        self.assertEqual(self.client.get("/api/search?ra=269&dec=4&fov=3").status_code, 502)

    @patch("app.query_collection", return_value=([record()], True, 0))
    def test_truncation_is_reported_and_release_scope_is_preserved(self, query):
        response = self.client.get("/api/search?ra=269&dec=4&fov=3&release=dr1&deep=1")
        self.assertEqual(response.json["collections"], ["spherex_dr1", "spherex_dr1_deep"])
        self.assertEqual(len(response.json["warnings"]), 2)

    def test_votable_names_and_observation_dates(self):
        table = Table({
            "access_url": [record()["url"]], "t_min": [60914.2], "obs_id": ["test"],
            "energy_bandpassname": ["SPHEREx-D1"], "em_min": [0.75e-6], "em_max": [1.1e-6],
        })
        output = io.BytesIO()
        writeto(from_table(table), output)
        rows, truncated, skipped = app.parse_records(output.getvalue(), "spherex_dr1")
        self.assertFalse(truncated)
        self.assertEqual(rows[0]["date"][:10], "2025-08-27")
        self.assertAlmostEqual(rows[0]["range_um"][0], 0.75)

    def test_invalid_archive_table_is_explicit_error(self):
        with self.assertLogs(app.app.logger, level="ERROR"), self.assertRaises(app.ViewerError):
            app.parse_records(b"<html>Maintenance</html>", "spherex_dr1")

    def test_cutout_urls_are_restricted_to_current_irsa_spectral_images(self):
        for url in ("https://evil.example/file.fits", "http://irsa.ipac.caltech.edu/file.fits",
                    "https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/a.fits",
                    record()["url"] + "?redirect=evil"):
            with self.subTest(url=url), self.assertRaises(app.ViewerError):
                app.cutout_url(url, 1, 2, 0.05)
        self.assertIn("size=0.07500000", app.cutout_url(record()["url"], 1, 2, 0.05))

    def test_interpolation_preserves_missing_data_and_does_not_wrap_edges(self):
        data = np.array([[0., 1.], [2., 3.]])
        x = np.array([0.5, -0.1, 1.1, np.nan])
        y = np.array([0.5] * 4)
        result = app.bilinear(data, x, y)
        self.assertEqual(result[0], 1.5)
        self.assertTrue(np.isnan(result[1:]).all())
        data[0, 0] = np.nan
        self.assertTrue(np.isnan(app.bilinear(data, x, y)).all())

    def test_rotated_fits_is_centered_and_wavelength_is_in_microns(self):
        frame = app.render_cutout(synthetic_cutout(), 269.4521, 4.6934, 0.05)
        pixels = np.frombuffer(base64.b64decode(frame["pixels"]), dtype="<f4").reshape(128, 128)
        peak_y, peak_x = np.unravel_index(np.argmax(pixels), pixels.shape)
        self.assertLessEqual(abs(peak_x - 63.5), 1)
        self.assertLessEqual(abs(peak_y - 63.5), 1)
        self.assertEqual(frame["coverage"], 100)
        self.assertTrue(frame["center_covered"])
        self.assertAlmostEqual(frame["wavelength_um"], 1)
        self.assertAlmostEqual(frame["bandwidth_um"], 0.025)

    def test_north_and_east_orientation_on_common_grid(self):
        wcs = WCS(naxis=2)
        wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
        wcs.wcs.crval = [10, 0]
        wcs.wcs.crpix = [51, 51]
        wcs.wcs.cdelt = [0.001, 0.001]
        yy, xx = np.indices((101, 101))
        data = np.exp(-((xx - 60) ** 2 + (yy - 65) ** 2) / 2)
        h = wcs.to_header()
        for key, value in {"CTYPE1W": "LINEAR", "CTYPE2W": "LINEAR", "CDELT1W": 1,
                           "CDELT2W": 1, "CRVAL1W": 1, "CRVAL2W": 0.02}.items():
            h[key] = value
        output = io.BytesIO()
        fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(data, h, name="IMAGE"),
                      fits.ImageHDU(np.zeros_like(data), name="FLAGS")]).writeto(output)
        frame = app.render_cutout(output.getvalue(), 10, 0, 0.05)
        pixels = np.frombuffer(base64.b64decode(frame["pixels"]), dtype="<f4").reshape(128, 128)
        y, x = np.unravel_index(np.argmax(pixels), pixels.shape)
        self.assertLess(x, 64, "East must be left")
        self.assertLess(y, 64, "North must be up")

    def test_spectral_mapping_does_not_apply_celestial_sip(self):
        with fits.open(io.BytesIO(synthetic_cutout())) as hdus:
            h = hdus["IMAGE"].header
            h["CTYPE1"] = "RA---TAN-SIP"
            h["CTYPE2"] = "DEC--TAN-SIP"
            h["A_ORDER"] = 2
            h["B_ORDER"] = 2
            h["A_2_0"] = 0.002
            h["B_0_2"] = 0.002
            celestial = WCS(h).celestial
            ra, dec = celestial.all_pix2world(60, 60, 0)
            output = io.BytesIO()
            hdus.writeto(output)
        frame = app.render_cutout(output.getvalue(), float(ra), float(dec), 0.025)
        self.assertAlmostEqual(frame["wavelength_um"], 1.01, places=7)
        self.assertAlmostEqual(frame["bandwidth_um"], 0.026, places=7)

    @patch("app.time.sleep")
    @patch("app.urlopen")
    def test_transient_retries_are_bounded_and_logged(self, fetch, sleep):
        fetch.side_effect = HTTPError("https://irsa.ipac.caltech.edu/SIA", 503, "Busy", {}, None)
        with self.assertLogs(app.app.logger, level="WARNING"), self.assertRaises(app.ViewerError):
            app.archive_get("https://irsa.ipac.caltech.edu/SIA", 100)
        self.assertEqual(fetch.call_count, 1 + len(app.RETRY_DELAYS))
        self.assertEqual([c.args[0] for c in sleep.call_args_list], list(app.RETRY_DELAYS))

    @patch("app.archive_get", return_value=synthetic_cutout())
    def test_frame_cache_and_expired_search(self, fetch):
        r = record()
        r["cutout_url"] = app.cutout_url(r["url"], 269.4521, 4.6934, 0.05)
        app.searches["test"] = {"created": time.monotonic(), "records": [r],
                                "ra": 269.4521, "dec": 4.6934, "fov": 0.05}
        for _ in range(2):
            self.assertEqual(self.client.get("/api/frame/test/0").status_code, 200)
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(self.client.get("/api/frame/test/99999").status_code, 404)
        app.searches["test"]["created"] -= app.TTL + 1
        self.assertEqual(self.client.get("/api/frame/test/0").status_code, 410)


if __name__ == "__main__":
    unittest.main()
