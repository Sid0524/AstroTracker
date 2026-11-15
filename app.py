"""Small local SPHEREx viewer: bounded archive queries and on-demand cutouts."""

import base64
import io
import json
import logging
import math
import re
import secrets
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPException
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
# IRSA often returns bursts of 502s; retry twice with backoff.
RETRY_DELAYS = (1, 4)
searches = OrderedDict()
frames = OrderedDict()
cache_lock = threading.Lock()
archive_slots = threading.BoundedSemaphore(3)
FRAME_CACHE = 64
# Pixels come from IRSA's public S3 copy (partial reads); IRSA cutouts are the fallback.
S3_BUCKET = "nasa-irsa-spherex"
S3_BASE = f"https://{S3_BUCKET}.s3.us-east-1.amazonaws.com/"
s3_slots = threading.BoundedSemaphore(8)
try:
    import aiohttp
    import fsspec  # astropy's use_fsspec needs it installed
    S3_FSSPEC_VERSION = fsspec.__version__
    S3_OPTIONS = {"block_size": 256 * 1024, "cache_type": "blockcache",
                  "client_kwargs": {"timeout": aiohttp.ClientTimeout(total=30)}}
except ImportError:  # optional: without fsspec every frame uses IRSA cutouts
    S3_OPTIONS = None


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
        for attempt, delay in enumerate((*RETRY_DELAYS, None)):
            try:
                with urlopen(Request(url, headers={"User-Agent": "SPHEREx-Sky-Viewer/0.1"}),
                             timeout=90) as response:
                    data = response.read(byte_limit + 1)
                break
            except HTTPError as exc:
                if delay is None or exc.code not in (429, 502, 503, 504):
                    raise
                app.logger.warning("IRSA returned %s; retry %d/%d in %ss",
                                   exc.code, attempt + 1, len(RETRY_DELAYS), delay)
            except HTTPException as exc:
                if delay is None:
                    raise
                app.logger.warning("IRSA response was cut off (%s); retry %d/%d in %ss",
                                   exc, attempt + 1, len(RETRY_DELAYS), delay)
            time.sleep(delay)
        if len(data) > byte_limit:
            raise ViewerError("Archive response exceeds the demo limit. Narrow the field or release.")
        return data
    # HTTPException: body cut off mid-download (not an OSError).
    except (HTTPError, URLError, TimeoutError, OSError, HTTPException) as exc:
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


def s3_url(row):
    """HTTPS URL of the exposure's AWS copy, or None if absent or unexpected."""
    if "cloud_access" not in row.colnames or np.ma.is_masked(row["cloud_access"]):
        return None
    try:
        aws = json.loads(str(row["cloud_access"]))["aws"]
        bucket, key = aws["bucket_name"], aws["key"]
    except (ValueError, KeyError, TypeError):
        return None
    if (bucket != S3_BUCKET or ".." in key
            or not re.fullmatch(r"(dr1|qr3)/level2/[A-Za-z0-9_./-]+\.fits", key)):
        return None
    return S3_BASE + key


def parse_row(row, url, collection):
    """Return one observation record, or None if the row is unusable."""
    if any(np.ma.is_masked(row[name])
           for name in ("t_min", "energy_bandpassname", "em_min", "em_max")):
        return None
    try:
        mjd = float(row["t_min"])
        em_min, em_max = float(row["em_min"]), float(row["em_max"])
    except (TypeError, ValueError, np.ma.MaskError):
        return None
    band = str(row["energy_bandpassname"])
    if (not all(math.isfinite(v) for v in (mjd, em_min, em_max))
            or not re.fullmatch(r"SPHEREx-D[1-6]", band)):
        return None
    return {
        "url": url, "s3_url": s3_url(row), "mjd": mjd,
        "date": Time(mjd, format="mjd", scale="utc").isot[:19] + "Z",
        "observation": str(row["obs_id"]), "band": band,
        "release": collection.split("_")[1].upper(), "collection": collection,
        "range_um": [em_min * 1e6, em_max * 1e6],
    }


def parse_records(raw, collection):
    """Parse an SIA VOTable into (records, truncated, skipped_rows)."""
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
        skipped = 0
        for row in table[:MAX_RECORDS]:
            url = str(row["access_url"])
            if url in seen:
                continue
            seen.add(url)
            record = parse_row(row, url, collection)
            if record is None:
                # Skip and count bad rows rather than dropping the collection.
                skipped += 1
                continue
            records.append(record)
        if skipped:
            app.logger.warning("%s: skipped %d malformed IRSA rows", collection, skipped)
        return records, truncated, skipped
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


def plural(n, word):
    return f"{n} {word}{'' if n == 1 else 's'}"


def collection_status(rows, truncated, skipped, error):
    """Classify a collection result: ok, empty, partial, truncated or failed (unknown)."""
    if error is not None:
        return "failed", f"{error} Coverage in this collection is unknown."
    if skipped and not rows:
        return "failed", (f"all {plural(skipped, 'returned row')} {'was' if skipped == 1 else 'were'} unreadable. "
                          "Coverage in this collection is unknown.")
    if truncated:
        return "truncated", f"results capped at {MAX_RECORDS}; narrow the search."
    if skipped:
        return "partial", f"{plural(skipped, 'malformed row')} skipped; the list may be incomplete."
    if not rows:
        return "empty", "no overlapping exposures."
    return "ok", f"{plural(len(rows), 'exposure')}."


def s3_cutout(url, ra, dec, fov):
    """Partial S3 read, repackaged like an IRSA cutout for render_cutout()."""
    if not s3_slots.acquire(timeout=10):
        raise TimeoutError("S3 reads are busy")
    try:
        with fits.open(url, use_fsspec=True, fsspec_kwargs=S3_OPTIONS) as hdus:
            image = hdus["IMAGE"]
            header = image.header
            wcs = WCS(header).celestial
            half = fov * 1.5 / 2  # same padding as the IRSA cutout request
            dra = half / max(math.cos(math.radians(dec)), 1e-6)
            ras = np.array([ra - dra, ra + dra, ra - dra, ra + dra, ra])
            decs = np.array([dec - half, dec - half, dec + half, dec + half, dec])
            x, y = wcs.all_world2pix(ras, decs, 0, quiet=True)
            if not (np.isfinite(x).all() and np.isfinite(y).all()):
                raise ValueError("field corners could not be mapped to detector pixels")
            nx, ny = header["NAXIS1"], header["NAXIS2"]
            x0, x1 = max(0, math.floor(x.min()) - 2), min(nx, math.ceil(x.max()) + 3)
            y0, y1 = max(0, math.floor(y.min()) - 2), min(ny, math.ceil(y.max()) + 3)
            if x1 - x0 < 2 or y1 - y0 < 2:
                raise ViewerError("This exposure has no usable two-dimensional cutout.", 422)
            data = image.section[y0:y1, x0:x1]
            flags = hdus["FLAGS"].section[y0:y1, x0:x1]
            shifted = header.copy()
            # Both WCSs are in detector pixels: shift the reference pixels.
            for suffix in ("", "W"):
                if f"CRPIX1{suffix}" in shifted:
                    shifted[f"CRPIX1{suffix}"] -= x0
                    shifted[f"CRPIX2{suffix}"] -= y0
            output = io.BytesIO()
            fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(data, shifted, name="IMAGE"),
                          fits.ImageHDU(flags, name="FLAGS"),
                          hdus["WCS-WAVE"].copy()]).writeto(output)
            return output.getvalue()
    finally:
        s3_slots.release()


def fetch_cutout(record, ra, dec, fov):
    """Return (FITS bytes, source); prefer S3, fall back to the IRSA cutout service."""
    if record.get("s3_url") and S3_OPTIONS is not None:
        try:
            return s3_cutout(record["s3_url"], ra, dec, fov), "s3"
        except ViewerError:
            raise  # the field is genuinely off this exposure; IRSA would agree
        except Exception as exc:  # network, timeout, unexpected file layout
            app.logger.warning("S3 read failed (%s: %s); using IRSA cutout",
                               type(exc).__name__, exc)
    return archive_get(record["cutout_url"], 16 * 1024 * 1024), "irsa"


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
    records, warnings, statuses = [], [], []
    with ThreadPoolExecutor(max_workers=2) as pool:
        jobs = [(c, pool.submit(query_collection, c, ra, dec, fov)) for c in selected]
        for collection, future in jobs:
            try:
                rows, truncated, skipped = future.result()
            except ViewerError as exc:
                rows, truncated, skipped, error = [], False, 0, str(exc)
            else:
                error = None
            status, message = collection_status(rows, truncated, skipped, error)
            if status not in ("ok", "empty"):
                warnings.append(f"{collection}: {message}")
            records.extend(rows)
            statuses.append({"collection": collection, "status": status, "count": len(rows),
                             "skipped": skipped, "message": message})
    if not records and all(s["status"] == "failed" for s in statuses):
        raise ViewerError("No collection could be queried. " + " ".join(warnings))
    records.sort(key=lambda r: (r["mjd"], r["band"], r["collection"], r["url"]))
    public = []
    for i, record in enumerate(records):
        record["id"] = str(i)
        record["cutout_url"] = cutout_url(record["url"], ra, dec, fov)
        public.append({k: v for k, v in record.items() if k not in ("url", "s3_url")})
    token = secrets.token_urlsafe(18)
    with cache_lock:
        searches[token] = {"created": time.monotonic(), "records": records,
                           "ra": ra, "dec": dec, "fov": fov}
        while len(searches) > 8:
            searches.popitem(last=False)
    return jsonify(search_id=token, records=public, warnings=warnings,
                   collections=selected, collection_status=statuses,
                   ra=ra, dec=dec, fov_arcmin=fov * 60)


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
    raw, source = fetch_cutout(record, entry["ra"], entry["dec"], entry["fov"])
    result = render_cutout(raw, entry["ra"], entry["dec"], entry["fov"])
    result["id"] = record_id
    result["source"] = source
    with cache_lock:
        frames[key] = result
        while len(frames) > FRAME_CACHE:
            frames.popitem(last=False)
    return jsonify(result)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    app.run(host="127.0.0.1", port=8000, threaded=True, debug=False)
