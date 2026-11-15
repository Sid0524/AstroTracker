"""Live check of SPHEREx DR1/QR3 coverage for the challenge test targets.

Runs the viewer's own query and cutout code against IRSA and prints a Markdown
report: per-collection status, dates, survey windows, detector coverage,
DR1/QR3 overlap, and (optionally) cutout spot checks that test whether the
moving target actually falls inside the displayed field.

    python tools/verify_releases.py                 # metadata + cutout checks
    python tools/verify_releases.py --no-cutouts    # metadata only (fast)
    python tools/verify_releases.py --json out.json # also save raw results

Results depend on the live archive. Re-run after every new SPHEREx release and
paste the output into docs/VERIFICATION.md.
"""

import argparse
import base64
import json
import math
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import app  # noqa: E402

J2000_MJD = 51544.5
DAYS_PER_YEAR = 365.25

# Proper motions in arcsec/yr (RA term includes cos Dec). Parallax is ignored:
# it is below 0.6 arcsec for both stars, under 0.1 SPHEREx pixel.
TARGETS = {
    "barnard": {
        "label": "Barnard's Star (viewer sample, J2026 center)",
        "center": (269.446268, 4.768204),
        # SIMBAD J2000 position and proper motion, as quoted in README.md.
        "motion": {"ra": 269.452077, "dec": 4.693365, "epoch_mjd": J2000_MJD,
                   "pmra": -0.801551, "pmdec": 10.362394, "source": "SIMBAD (README)"},
    },
    "wise0855_ref": {
        "label": "WISE 0855 (viewer sample = ~2010 reference position)",
        "center": (133.7951292, -7.2451472),
        "motion": "wise0855",
    },
    "wise0855_2026": {
        "label": "WISE 0855 (propagated to 2026.0 with CatWISE2020 motion)",
        "center": None,  # computed below
        "motion": "wise0855",
    },
}
# CatWISE2020 splits this very fast object into several entries; this is the
# latest-epoch one (J085506.91-071437.5, MJD 57853.135), checked 2026-11-14.
WISE0855 = {"ra": 133.7788255, "dec": -7.2437546, "epoch_mjd": 57853.135215,
            "pmra": -7.91990, "pmdec": 0.49390, "source": "CatWISE2020 J085506.91-071437.5"}
for target in TARGETS.values():
    if target["motion"] == "wise0855":
        target["motion"] = WISE0855


def propagate(motion, mjd):
    """Linear space motion on the sky; adequate over decades at these rates."""
    years = (mjd - motion["epoch_mjd"]) / DAYS_PER_YEAR
    dec = motion["dec"] + motion["pmdec"] * years / 3600
    ra = motion["ra"] + motion["pmra"] * years / 3600 / math.cos(math.radians(dec))
    return ra % 360, dec


TARGETS["wise0855_2026"]["center"] = tuple(round(v, 6) for v in propagate(WISE0855, 61041.0))


def offset_arcsec(center, position):
    """(east, north) offset of position from center, in arcsec."""
    dra = ((position[0] - center[0] + 180) % 360) - 180
    return (dra * math.cos(math.radians(center[1])) * 3600, (position[1] - center[1]) * 3600)


def survey_windows(mjds, gap_days=30):
    windows = []
    for mjd in sorted(mjds):
        if windows and mjd - windows[-1][-1] <= gap_days:
            windows[-1].append(mjd)
        else:
            windows.append([mjd])
    return windows


def day(mjd):
    from astropy.time import Time
    return Time(mjd, format="mjd", scale="utc").isot[:10]


def query(target, fov_arcmin, deep, retries):
    ra, dec = target["center"]
    results = {}
    for collection in app.COLLECTIONS:
        if collection.endswith("_deep") and not deep:
            continue
        failures = 0
        while True:
            try:
                rows, truncated, skipped = app.query_collection(collection, ra, dec, fov_arcmin / 60)
                error = None
            except app.ViewerError as exc:
                rows, truncated, skipped, error = [], False, 0, str(exc)
            status, message = app.collection_status(rows, truncated, skipped, error)
            if status != "failed" or failures >= retries:
                break
            failures += 1
            print(f"  {collection} failed ({error}); retry {failures}/{retries} in 10 s",
                  file=sys.stderr)
            time.sleep(10)
        results[collection] = {"status": status, "message": message, "rows": rows,
                               "failed_attempts": failures}
    return results


def detection(frame, target, record, fov_arcmin):
    """Peak robust S/N within 2 native pixels of the predicted target position."""
    size = frame["size"]
    pixels = np.frombuffer(base64.b64decode(frame["pixels"]), dtype="<f4").reshape(size, size)
    scale = fov_arcmin * 60 / size
    east, north = offset_arcsec(target["center"], propagate(target["motion"], record["mjd"]))
    x, y = (size - 1) / 2 - east / scale, (size - 1) / 2 - north / scale
    inside = 0 <= x <= size - 1 and 0 <= y <= size - 1
    result = {"predicted_offset_arcsec": [round(east, 1), round(north, 1)], "inside_field": inside}
    if not inside:
        return result
    finite = pixels[np.isfinite(pixels)]
    median = float(np.median(finite))
    noise = 1.4826 * float(np.median(np.abs(finite - median))) or float("nan")
    radius = 2 * 6.15 / scale
    yy, xx = np.indices(pixels.shape)
    near = ((xx - x) ** 2 + (yy - y) ** 2 <= radius ** 2) & np.isfinite(pixels)
    result["finite_at_target"] = bool(near.any())
    if near.any():
        result["peak_snr"] = round((float(pixels[near].max()) - median) / noise, 1)
    return result


def spot_checks(target, results, fov_arcmin, bands):
    checks = []
    records = [r for c in results.values() for r in c["rows"]]
    for collection in sorted({r["collection"] for r in records}):
        for band in bands:
            rows = sorted((r for r in records if r["collection"] == collection and r["band"] == band),
                          key=lambda r: r["mjd"])
            for record in {id(r): r for r in (rows[:1] + rows[-1:])}.values():
                entry = {"collection": collection, "band": band, "date": record["date"],
                         "observation": record["observation"]}
                try:
                    ra, dec = target["center"]
                    url = app.cutout_url(record["url"], ra, dec, fov_arcmin / 60)
                    frame = app.render_cutout(app.archive_get(url, 16 * 1024 * 1024),
                                              ra, dec, fov_arcmin / 60)
                    entry.update(coverage=frame["coverage"], center_covered=frame["center_covered"],
                                 wavelength_um=frame["wavelength_um"],
                                 flagged_percent=frame["flagged_percent"],
                                 **detection(frame, target, record, fov_arcmin))
                except app.ViewerError as exc:
                    entry["error"] = str(exc)
                checks.append(entry)
    return checks


def report(name, target, results, checks, fov_arcmin):
    out = [f"### {target['label']}", "",
           f"Center RA {target['center'][0]:.6f}, Dec {target['center'][1]:.6f}; "
           f"{fov_arcmin} arcmin field; motion source: {target['motion']['source']}.", ""]
    out += ["| Collection | Status | Exposures | UTC dates | First | Last | Survey windows |",
            "|---|---|---|---|---|---|---|"]
    for collection, result in results.items():
        rows = result["rows"]
        mjds = [r["mjd"] for r in rows]
        windows = survey_windows(mjds)
        spans = "; ".join(f"{day(w[0])}..{day(w[-1])} ({len(w)})" for w in windows) or "-"
        status = result["status"]
        if result.get("failed_attempts"):
            status += f" (after {result['failed_attempts']} failed attempt(s))"
        out.append(f"| `{collection}` | {status} | {len(rows)} | "
                   f"{len({day(m) for m in mjds})} | {day(min(mjds)) if mjds else '-'} | "
                   f"{day(max(mjds)) if mjds else '-'} | {spans} |")
        if result["status"] not in ("ok", "empty"):
            out.append(f"|  | _{result['message']}_ | | | | | |")
    out += ["", "| Detector | " + " | ".join(f"`{c}`" for c in results) + " |",
            "|---|" + "---|" * len(results)]
    for band in [f"SPHEREx-D{i}" for i in range(1, 7)]:
        cells = []
        for result in results.values():
            dates = sorted({day(r["mjd"]) for r in result["rows"] if r["band"] == band})
            count = sum(r["band"] == band for r in result["rows"])
            cells.append(f"{count} on {len(dates)} date{'' if len(dates) == 1 else 's'}" if count else "none")
        out.append(f"| {band[-2:]} | " + " | ".join(cells) + " |")
    dr1 = {r["observation"] for r in results.get("spherex_dr1", {"rows": []})["rows"]}
    qr3 = {r["observation"] for r in results.get("spherex_qr3", {"rows": []})["rows"]}
    if dr1 and qr3:
        out += ["", f"DR1/QR3 overlap: {len(dr1 & qr3)} observation ID{'' if len(dr1 & qr3) == 1 else 's'} (obs_id, shared by "
                "several exposures) appear in both releases "
                f"({len(dr1 - qr3)} DR1-only, {len(qr3 - dr1)} QR3-only)."]
    if checks:
        out += ["", "Cutout spot checks (first/last exposure per collection and detector). "
                "Peak S/N is the brightest pixel within 2 native pixels of the predicted "
                "position; a neighbouring source can produce it, so it is a sanity check, "
                "not a detection. Any-FLAGS % counts every set bit, including source bits.", "",
                "| Collection | Det | UTC | Coverage | Target offset E,N (arcsec) | In field | "
                "Peak S/N within 12\" | lambda (um) | Any FLAGS % |",
                "|---|---|---|---|---|---|---|---|---|"]
        for c in checks:
            if "error" in c:
                out.append(f"| `{c['collection']}` | {c['band'][-2:]} | {c['date'][:10]} | "
                           f"error: {c['error']} | | | | | |")
                continue
            wave = f"{c['wavelength_um']:.3f}" if c.get("wavelength_um") else "-"
            out.append(f"| `{c['collection']}` | {c['band'][-2:]} | {c['date'][:10]} | "
                       f"{c['coverage']}% | {c['predicted_offset_arcsec'][0]}, "
                       f"{c['predicted_offset_arcsec'][1]} | {'yes' if c['inside_field'] else 'NO'} | "
                       f"{c.get('peak_snr', '-')} | {wave} | {c['flagged_percent']} |")
    return "\n".join(out) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--targets", nargs="+", default=list(TARGETS), choices=list(TARGETS))
    parser.add_argument("--fov", type=float, default=3.0, help="field width in arcmin (1-12)")
    parser.add_argument("--deep", action="store_true", help="also query the _deep collections")
    parser.add_argument("--no-cutouts", action="store_true", help="metadata only")
    parser.add_argument("--bands", nargs="+", default=["SPHEREx-D1", "SPHEREx-D6"])
    parser.add_argument("--retries", type=int, default=2,
                        help="re-query a failed collection up to N times (default 2)")
    parser.add_argument("--json", type=Path, help="write raw results to this file")
    args = parser.parse_args()

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    print(f"## Live verification run, {stamp}\n")
    raw = {}
    for name in args.targets:
        target = TARGETS[name]
        print(f"[{name}] querying IRSA...", file=sys.stderr)
        results = query(target, args.fov, args.deep, args.retries)
        checks = [] if args.no_cutouts else spot_checks(target, results, args.fov, args.bands)
        print(report(name, target, results, checks, args.fov))
        raw[name] = {"center": target["center"],
                     "collections": {c: {k: v for k, v in r.items() if k != "rows"} |
                                     {"dates": sorted({x["date"] for x in r["rows"]})}
                                     for c, r in results.items()},
                     "spot_checks": checks}
    if args.json:
        args.json.write_text(json.dumps(raw, indent=2))


if __name__ == "__main__":
    main()
