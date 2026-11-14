"""Small local SPHEREx viewer: bounded archive queries and on-demand cutouts."""

import base64
import io
import logging
import math
import re
import secrets
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

import numpy as np
from astropy.io import fits
from astropy.io.votable import parse
from astropy.time import Time
from astropy.wcs import WCS
from astropy.wcs.wcs import NoConvergence
from flask import Flask, jsonify, request

app = Flask(__name__, static_folder="static", static_url_path="/static")
COLLECTIONS = ("spherex_dr1", "spherex_qr3", "spherex_dr1_deep", "spherex_qr3_deep")
MAX_RECORDS = 1500
GRID_SIZE = 128
TTL = 3600
searches = OrderedDict()
frames = OrderedDict()
cache_lock = threading.Lock()
archive_slots = threading.BoundedSemaphore(3)


class ViewerError(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


def number(value, name, low, high, inclusive_high=True):
    try:
        result = float(value)
    except (ValueError, TypeError):
        raise ViewerError(f"{name} must be a number.", 400) from None
    if not math.isfinite(result) or result < low or result > high or (
        not inclusive_high and result == high
    ):
        endpoint = "<=" if inclusive_high else "<"
        raise ViewerError(f"{name} must satisfy {low} <= {name} {endpoint} {high}.", 400)
    return result


def archive_get(url, byte_limit):
    if not archive_slots.acquire(timeout=2):
        raise ViewerError("Archive requests are busy. Please retry shortly.", 503)
    try:
        for attempt in range(2):
            try:
                with urlopen(Request(url, headers={"User-Agent": "SPHEREx-Sky-Viewer/0.1"}),
                             timeout=90) as response:
                    data = response.read(byte_limit + 1)
                break
            except HTTPError as exc:
                if attempt == 0 and exc.code in (429, 502, 503, 504):
                    app.logger.warning("IRSA returned %s; retrying once", exc.code)
                    time.sleep(1)
                    continue
                raise
        if len(data) > byte_limit:
            raise ViewerError("Archive response exceeds the demo limit. Narrow the field or release.")
        return data
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        app.logger.warning("IRSA request failed: %s", exc)
        raise ViewerError("IRSA is unavailable or timed out. Please retry; no data were substituted.") from exc
    finally:
        archive_slots.release()


def cutout_url(url, ra, dec, fov):
    parts = urlsplit(url)
    if (parts.scheme != "https" or parts.netloc != "irsa.ipac.caltech.edu"
            or parts.query or parts.fragment
            or not re.fullmatch(
                r"/ibe/data/spherex/(dr1|qr3)/level2/[A-Za-z0-9_./-]+\.fits", parts.path
            ) or ".." in parts.path):
        raise ViewerError("IRSA returned an unexpected data URL; retrieval was blocked.")
    # A rotated detector cutout needs padding to cover the north-up square.
    return url + "?" + urlencode({"center": f"{ra},{dec}", "size": f"{fov * 1.5:.8f}"})


def parse_records(raw, collection):
    try:
        document = parse(io.BytesIO(raw))
        statuses = [info for resource in document.resources for info in resource.infos
                    if info.name == "QUERY_STATUS"]
        if any(info.value == "ERROR" for info in statuses):
            raise ViewerError("IRSA rejected the image query. Please retry with a smaller field.")
        table = document.get_first_table().to_table(use_names_over_ids=True)
        required = {"access_url", "t_min", "obs_id", "energy_bandpassname", "em_min", "em_max"}
        if not required.issubset(table.colnames):
            raise ViewerError("IRSA returned an unrecognized observation table.")
        truncated = len(table) > MAX_RECORDS or any(info.value == "OVERFLOW" for info in statuses)
        records = []
        seen = set()
        for row in table[:MAX_RECORDS]:
            url = str(row["access_url"])
            if url in seen:
                continue
            seen.add(url)
            mjd = float(row["t_min"])
            if not math.isfinite(mjd):
                raise ViewerError("IRSA returned an observation without a valid time.")
            band = str(row["energy_bandpassname"])
            if not re.fullmatch(r"SPHEREx-D[1-6]", band):
                raise ViewerError("IRSA returned an unrecognized detector band.")
            records.append({
                "url": url, "mjd": mjd,
                "date": Time(mjd, format="mjd", scale="utc").isot[:19] + "Z",
                "observation": str(row["obs_id"]), "band": band,
                "release": collection.split("_")[1].upper(), "collection": collection,
                "range_um": [float(row["em_min"]) * 1e6, float(row["em_max"]) * 1e6],
            })
        return records, truncated
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        app.logger.exception("Could not decode IRSA metadata")
        raise ViewerError("Could not read the IRSA observation response.") from exc


def query_collection(collection, ra, dec, fov):
    # Use the circumscribed display circle; confirm actual pixel coverage on rendering.
    url = "https://irsa.ipac.caltech.edu/SIA?" + urlencode({
        "COLLECTION": collection, "POS": f"CIRCLE {ra} {dec} {fov / math.sqrt(2)}",
        "RESPONSEFORMAT": "VOTABLE", "MAXREC": MAX_RECORDS + 1,
    })
    return parse_records(archive_get(url, 8 * 1024 * 1024), collection)


def bilinear(data, x, y):
    """Conservative interpolation: every contributing pixel must be finite."""
    height, width = data.shape
    valid = np.isfinite(x) & np.isfinite(y) & (x >= 0) & (y >= 0)
    valid &= (x <= width - 1) & (y <= height - 1)
    safe_x = np.clip(np.where(valid, x, 0), 0, width - 1)
    safe_y = np.clip(np.where(valid, y, 0), 0, height - 1)
    x0, y0 = np.floor(safe_x).astype(int), np.floor(safe_y).astype(int)
    x1, y1 = np.minimum(x0 + 1, width - 1), np.minimum(y0 + 1, height - 1)
    dx, dy = safe_x - x0, safe_y - y0
    result = ((1 - dx) * (1 - dy) * data[y0, x0] + dx * (1 - dy) * data[y0, x1]
              + (1 - dx) * dy * data[y1, x0] + dx * dy * data[y1, x1])
    return np.where(valid, result, np.nan)


def render_cutout(raw, ra, dec, fov):
    try:
        with fits.open(io.BytesIO(raw), memmap=False) as hdus:
            image = hdus["IMAGE"]
            data = np.asarray(image.data, dtype=float)
            if data.ndim != 2 or min(data.shape) < 2:
                raise ViewerError("This exposure has no usable two-dimensional cutout.", 422)
            source = WCS(image.header, fobj=hdus).celestial
            output = WCS(naxis=2)
            output.wcs.ctype = ["RA---TAN", "DEC--TAN"]
            output.wcs.crval = [ra, dec]
            output.wcs.crpix = [(GRID_SIZE + 1) / 2] * 2
            output.wcs.cdelt = [-fov / GRID_SIZE, fov / GRID_SIZE]
            yy, xx = np.indices((GRID_SIZE, GRID_SIZE))
            sky_ra, sky_dec = output.all_pix2world(xx, yy, 0)
            sx, sy = source.all_world2pix(sky_ra, sky_dec, 0)
            aligned = bilinear(data, sx, sy)[::-1]
            finite = np.isfinite(aligned)
            if not finite.any():
                raise ViewerError("The requested field has no finite pixels in this exposure.", 422)
            cx, cy = source.all_world2pix(ra, dec, 0)
            center_covered = bool(0 <= cx <= data.shape[1] - 1 and 0 <= cy <= data.shape[0] - 1)
            wavelength = None
            bandwidth = None
            if center_covered:
                # The alternate spectral WCS maps detector pixels, not sky coordinates.
                # Astropy otherwise also imports the primary celestial SIP coefficients.
                wave_header = image.header.copy()
                for key in list(wave_header):
                    if re.fullmatch(r"(A|B|AP|BP)_(ORDER|DMAX|[0-9]+_[0-9]+)", key):
                        del wave_header[key]
                wave = WCS(wave_header, key="W", fobj=hdus, preserve_units=True)
                central, width = wave.all_pix2world(float(cx), float(cy), 0)
                if np.isfinite(central) and np.isfinite(width):
                    wavelength, bandwidth = float(central), float(width)
            flags = np.asarray(hdus["FLAGS"].data)
            return {
                "size": GRID_SIZE,
                "pixels": base64.b64encode(aligned.astype("<f4").tobytes()).decode("ascii"),
                "coverage": round(float(finite.mean()) * 100, 1),
                "center_covered": center_covered,
                "wavelength_um": wavelength, "bandwidth_um": bandwidth,
                "flagged_percent": round(float(np.count_nonzero(flags) / flags.size) * 100, 1),
                "astrometry_code": image.header.get("FINAST"),
                "unit": str(image.header.get("BUNIT", "MJy/sr")),
                "native_shape": list(data.shape),
                "percentiles": [float(x) for x in np.percentile(aligned[finite], [1, 99.5])],
            }
    except (OSError, ValueError, KeyError, IndexError, TypeError, NoConvergence) as exc:
        app.logger.exception("Could not decode or align FITS cutout")
        raise ViewerError("The FITS cutout could not be read or aligned. Try another exposure.") from exc


def get_search(token):
    with cache_lock:
        entry = searches.get(token)
        if entry is None or time.monotonic() - entry["created"] > TTL:
            raise ViewerError("This search expired. Search again to reload observations.", 410)
        searches.move_to_end(token)
        return entry


@app.errorhandler(ViewerError)
def viewer_error(error):
    return jsonify(error=str(error)), error.status


@app.get("/")
def index():
    return app.send_static_file("index.html")


@app.get("/api/search")
def search():
    ra = number(request.args.get("ra"), "RA", 0, 360, False)
    dec = number(request.args.get("dec"), "Dec", -90, 90)
    fov = number(request.args.get("fov"), "FOV (arcmin)", 1, 12) / 60
    requested = request.args.get("release", "both")
    if requested not in ("both", "dr1", "qr3"):
        raise ViewerError("Select DR1, QR3, or both releases.", 400)
    deep = request.args.get("deep", "0")
    if deep not in ("0", "1"):
        raise ViewerError("Deep survey must be 0 or 1.", 400)
    selected = [c for c in COLLECTIONS
                if (requested == "both" or c.split("_")[1] == requested)
                and (deep == "1" or not c.endswith("_deep"))]
    records, warnings = [], []
    with ThreadPoolExecutor(max_workers=2) as pool:
        jobs = [(c, pool.submit(query_collection, c, ra, dec, fov)) for c in selected]
        for collection, future in jobs:
            try:
                rows, truncated = future.result()
                records.extend(rows)
                if truncated:
                    warnings.append(f"{collection}: results capped at {MAX_RECORDS}; narrow the search.")
            except ViewerError as exc:
                warnings.append(f"{collection}: {exc}")
    if len(warnings) == len(selected) and not records:
        raise ViewerError("No collection could be queried. " + " ".join(warnings))
    records.sort(key=lambda r: (r["mjd"], r["band"], r["collection"], r["url"]))
    public = []
    for i, record in enumerate(records):
        record["id"] = str(i)
        record["cutout_url"] = cutout_url(record["url"], ra, dec, fov)
        public.append({k: v for k, v in record.items() if k != "url"})
    token = secrets.token_urlsafe(18)
    with cache_lock:
        searches[token] = {"created": time.monotonic(), "records": records,
                           "ra": ra, "dec": dec, "fov": fov}
        while len(searches) > 8:
            searches.popitem(last=False)
    return jsonify(search_id=token, records=public, warnings=warnings,
                   collections=selected, ra=ra, dec=dec, fov_arcmin=fov * 60)


@app.get("/api/frame/<token>/<record_id>")
def frame(token, record_id):
    entry = get_search(token)
    if not re.fullmatch(r"[0-9]{1,4}", record_id) or int(record_id) >= len(entry["records"]):
        raise ViewerError("Unknown observation. Search again.", 404)
    key = (token, record_id)
    with cache_lock:
        cached = frames.get(key)
        if cached is not None:
            frames.move_to_end(key)
            return jsonify(cached)
    record = entry["records"][int(record_id)]
    result = render_cutout(archive_get(record["cutout_url"], 16 * 1024 * 1024),
                           entry["ra"], entry["dec"], entry["fov"])
    result["id"] = record_id
    with cache_lock:
        frames[key] = result
        while len(frames) > 16:
            frames.popitem(last=False)
    return jsonify(result)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    app.run(host="127.0.0.1", port=8000, threaded=True, debug=False)
