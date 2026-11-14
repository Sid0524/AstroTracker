"""Live benchmark of the viewer's IRSA retry strategy.

For each target: one DR1+QR3 search (2 parallel SIA requests) and one cutout
of the first returned exposure, all through the real Flask endpoints. Every
HTTP attempt is recorded, so the report shows first-try vs final success,
retries used, and latency per endpoint.

    python tools/retry_benchmark.py [--json out.json]
"""

import argparse
import json
import statistics
import sys
import threading
import time
from pathlib import Path
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import app  # noqa: E402

# Fixed-position targets (degrees, ICRS). Moving targets from the demo list
# (3I/ATLAS, 4 Vesta) need an ephemeris and are not included.
TARGETS = [
    ("Barnard's Star (J2026)", 269.446268, 4.768204),
    ("WISE 0855 (2026)", 133.75947, -7.242557),
    ("Epsilon Indi", 330.840, -56.786),
    ("RW Aurigae", 76.956, 30.401),
    ("R Draconis", 245.135, 66.751),
    ("Pluto field, Oct 2025 (approx.)", 305.6, -23.2),
    ("North Ecliptic Pole", 270.0, 66.5607),
    ("South Ecliptic Pole", 90.0, -66.5607),
    ("Crab Nebula", 83.6331, 22.0145),
    ("Orion Nebula", 83.8221, -5.3911),
    ("Galactic Center", 266.4168, -29.0078),
    ("Andromeda (M31)", 10.6847, 41.2690),
    ("Pleiades", 56.75, 24.1167),
    ("Vega", 279.2347, 38.7837),
    ("Betelgeuse", 88.7929, 7.4071),
    ("M87", 187.7059, 12.3911),
    ("Large Magellanic Cloud", 80.8942, -69.7561),
    ("Proxima Centauri", 217.4289, -62.6795),
    ("Eagle Nebula (M16)", 274.7000, -13.8067),
    ("Ring Nebula (M57)", 283.3963, 33.0292),
]

local = threading.local()
CURRENT = [None]  # targets run one at a time; worker threads read this
log = []
log_lock = threading.Lock()
real_urlopen, real_archive_get = app.urlopen, app.archive_get


def urlopen(request, timeout=None):
    start = time.monotonic()
    try:
        response = real_urlopen(request, timeout=timeout)
        local.attempts.append({"outcome": "ok", "s": time.monotonic() - start})
        return response
    except HTTPError as exc:
        local.attempts.append({"outcome": f"HTTP {exc.code}", "s": time.monotonic() - start})
        raise
    except Exception as exc:
        local.attempts.append({"outcome": type(exc).__name__, "s": time.monotonic() - start})
        raise


def archive_get(url, byte_limit):
    local.attempts = []
    start = time.monotonic()
    kind = "metadata" if "/SIA?" in url else "cutout"
    entry = {"kind": kind, "target": CURRENT[0]}
    if kind == "metadata":
        entry["collection"] = url.split("COLLECTION=")[1].split("&")[0]
    try:
        data = real_archive_get(url, byte_limit)
        entry["ok"] = True
        return data
    except app.ViewerError:
        entry["ok"] = False
        raise
    finally:
        entry.update(seconds=round(time.monotonic() - start, 2), attempts=local.attempts)
        with log_lock:
            log.append(entry)


def pct(values, q):
    values = sorted(values)
    return values[min(len(values) - 1, round(q * (len(values) - 1)))] if values else float("nan")


def summarize(kind):
    rows = [e for e in log if e["kind"] == kind]
    if not rows:
        return f"{kind}: no requests"
    first = sum(e["attempts"] and e["attempts"][0]["outcome"] == "ok" for e in rows)
    final = sum(e["ok"] for e in rows)
    retried = [e for e in rows if len(e["attempts"]) > 1]
    rescued = sum(e["ok"] for e in retried)
    secs = [e["seconds"] for e in rows]
    fail_codes = {}
    for e in rows:
        for a in e["attempts"]:
            if a["outcome"] != "ok":
                fail_codes[a["outcome"]] = fail_codes.get(a["outcome"], 0) + 1
    return (f"{kind}: {len(rows)} requests | first-try success {first}/{len(rows)} "
            f"({100 * first / len(rows):.0f}%) | final success {final}/{len(rows)} "
            f"({100 * final / len(rows):.0f}%) | retried {len(retried)}, rescued by retry {rescued} | "
            f"attempts {sum(len(e['attempts']) for e in rows)} | latency p50 {statistics.median(secs):.1f}s "
            f"p95 {pct(secs, .95):.1f}s max {max(secs):.1f}s | failed attempts {fail_codes or 'none'}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", type=Path)
    args = parser.parse_args()
    app.urlopen, app.archive_get = urlopen, archive_get
    app.logging.disable(app.logging.WARNING)
    client = app.app.test_client()
    print(f"Retry policy: delays {app.RETRY_DELAYS}s, per-attempt timeout 90s\n")
    print("| Target | Search | Status per collection | Records | Search s | Cutout | Cutout s |")
    print("|---|---|---|---|---|---|---|")
    wall = time.monotonic()
    for name, ra, dec in TARGETS:
        CURRENT[0] = name
        t = time.monotonic()
        r = client.get(f"/api/search?ra={ra}&dec={dec}&fov=3&release=both")
        search_s = time.monotonic() - t
        body = r.get_json() or {}
        statuses = ", ".join(f"{s['collection'][8:]}={s['status']}"
                             for s in body.get("collection_status", [])) or body.get("error", "")[:40]
        cut, cut_s = "-", 0.0
        if body.get("records"):
            t = time.monotonic()
            fr = client.get(f"/api/frame/{body['search_id']}/0")
            cut_s = time.monotonic() - t
            cut = f"{fr.status_code}" + (f" ({fr.get_json()['coverage']}%, {fr.get_json()['source']})"
                                         if fr.status_code == 200 else "")
        print(f"| {name} | {r.status_code} | {statuses} | {len(body.get('records', []))} | "
              f"{search_s:.1f} | {cut} | {cut_s:.1f} |", flush=True)
        app.searches.clear()
        app.frames.clear()
    print(f"\nWall time: {time.monotonic() - wall:.0f}s\n")
    print(summarize("metadata"))
    print(summarize("cutout") + "  (IRSA cutout-service requests only; S3 reads show as "
          "'s3' in the Cutout column)")
    if args.json:
        args.json.write_text(json.dumps(log, indent=1))


if __name__ == "__main__":
    main()
