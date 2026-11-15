# DR1 / QR3 verification: Barnard's Star and WISE 0855

Checked on **2026-11-14** against live IRSA, using the viewer's own query and cutout
code (`tools/verify_releases.py`) and the browser UI. Archive contents change with
each release, so re-run after every new release and add a new dated section.

```powershell
.\.venv\Scripts\python.exe tools\verify_releases.py --deep
```

## Summary

| Target (3 arcmin field) | DR1 | QR3 | Deep collections | Target in field? |
|---|---|---|---|---|
| Barnard's Star, J2026 center | 252 exposures, 27 dates, 2025-08-15 to 2026-05-05, two survey windows | 128 exposures, 14 dates, 2026-08-16 to 2026-09-22, one window | none | Yes. Within 8 arcsec of center in every checked frame |
| WISE 0855, challenge reference position | 271 exposures, 28 dates, 2025-05-05 to 2026-05-14, three windows | **none** (empty, not failed) | none | **No.** The object is 122-130 arcsec west, outside the field (see note) |
| WISE 0855, 2026.0 propagated position | 259 exposures, 27 dates, same windows | **none** | none | Yes. Within 6 arcsec of center |

Note: "outside the field" means outside the 3 arcmin square (half-width 90 arcsec).
A 6 arcmin field around the reference position would include the object.

### Findings

1. **DR1 and QR3 do not overlap in time.** No observation ID appears in both. QR3
   holds the newest data (Aug-Sep 2026 for Barnard), so "DR1 + QR3" is the right
   default. A single release halves the time baseline.
2. **WISE 0855 has no QR3 coverage** at either position. Searching QR3 alone shows
   "No coverage in the searched collections"; with both releases, the QR3 chip
   reads "searched: no exposures here" and the DR1 data still display. That is the
   intended missing-release behavior: an empty release is reported as empty, and a
   failed release is reported as unknown (finding 4).
3. **The challenge's WISE 0855 coordinates miss the object.** They are an
   epoch-2010 position. With CatWISE2020 proper motion (-7.92, +0.49 arcsec/yr), the
   object is about 2.1 arcmin west by 2025-26. The viewer's WISE sample now uses the
   propagated 2026.0 position (RA 133.759470, Dec -7.242557); the reference
   position is kept as a second sample.
4. **IRSA was intermittently failing during testing.** SIA and TAP returned
   `502 Proxy Error` for minutes at a time, and individual collections failed in
   about half of the searches before the retry change. Each failure was shown as
   "query failed: coverage unknown", never as no coverage. Two retries with backoff
   (1 s, 4 s) replaced the single 1 s retry. All 3 UI searches run after that change
   completed, which is a small sample. TAP stayed down, so CatWISE was read through
   IRSA Gator instead.
5. **A footprint match does not guarantee pixels.** For Barnard's Star, QR3 D6
   cutouts had 17-18% coverage and did not reach the target, and a QR3 D3 exposure
   (2026-08-16) returned "no usable two-dimensional cutout". DR1 cutouts had 99-100%
   coverage.
6. **WISE 0855 is not clearly visible in single exposures.** At the propagated
   position, the brightest D6 pixel within 2 native pixels is 2-4 sigma. The 30-40
   sigma D1 peaks at that position are almost certainly a neighbouring source: the
   object is extremely faint below 2 um.
7. **The FLAGS percentage is not a quality measure.** It reads 100% around Barnard's
   Star because source-detection bits are included.

### UI checks (browser, same day)

- Barnard's Star, DR1 + QR3: 380 exposures, 41 dates in 3 survey windows. Both
  chips were "ok".
- During an IRSA outage, the same search showed one release's chip as
  "query failed: coverage unknown", and the status line said results were
  incomplete.
- Clicking a QR3 D3 mark switched the detector to D3 and selected that date.
  Pressing Enter on a DR1 D3 mark added a second date. Loading marked only the
  frame that actually loaded; the other showed IRSA's "no usable cutout" error.
- WISE 0855 (2026 position): QR3 only gave the no-coverage message and an empty
  timeline. DR1 + QR3 showed 259 DR1 exposures with an "empty" QR3 chip.
- At 375 px width, the timeline scrolls inside its panel and the page does not
  scroll sideways.

## SpaceLapse (deployed app), 2026-11-14

SpaceLapse searches a static index, last rebuilt on 2026-11-10, instead of querying IRSA.

| Target | Index result | Live IRSA (above) |
|---|---|---|
| Barnard's Star | 361 exposures, 40 dates, 2025-08-15 to 2026-09-22 (QR2 239, QR3 122) | Same date span; DR1 252 + QR3 128 |
| WISE 0855 (either position) | 256 exposures, 27 dates, 2025-05-05 to 2026-05-14 (QR2 only) | Same dates; no QR3 coverage |

The index counts every detector footprint that covers the point; IRSA's search
used a 3 arcmin circle. That explains the different counts.

- **QR2 is superseded.** IRSA now lists only QR3 and DR1. QR2 files are still on
  S3 (HTTP 200), so links work, but they are older processing (`l2b-v20`) than
  DR1 (`l2b-v27`). The index holds QR2 (129 folders) and QR3 (22), and no DR1.
- **DR1 rebuild.** The builder and the app already support DR1, and the app
  prefers DR1 over QR copies of the same exposure. The weekly workflow adds DR1
  folders. TAP was slow during testing (one DR1 folder, 8,142 rows, took 11
  minutes), so the workflow now has a 120-minute budget. Folders that are
  unfinished or failed are retried on the next run, so DR1 fills in over several
  runs. A manual run of "Update SPHEREx index and tracks" speeds this up.
- **Missing-release behavior (new).** An empty search names the searched releases,
  the index date, and that DR1 is not indexed yet. If some index tiles fail, the
  results still show with a "Coverage incomplete" warning. If all fail, the app
  reports "coverage is unknown".
- **Browser check:** Barnard's Star showed 6 detector rows and 101 coverage marks
  (QR2 and QR3) in 3 survey windows. Clicking a D6 mark switched the detector to D6.

### Revisiting a detector (SpaceLapse, Barnard's Star, 96 px field)

| Step | Before cutout cache | With cutout cache |
|---|---|---|
| D3 first visit | 222 requests, 80.1 MB, 23 s | same |
| D4 first visit | 176 requests, 62.9 MB, 18 s | same |
| D3 again | 106 requests, 76.3 MB, 21 s | **0 requests, 0 MB, immediate** |
| D4 again | (not measured) | **0 requests, 0 MB, immediate** |

## Retry benchmark in the browser UI (2026-11-14, 15:04-15:11 local)

Twenty fixed targets were run through the real page. For each target the run set
RA/Dec, clicked **Search this field** (DR1 + QR3, 3 arcmin), then **Load selected**
(the first and last dates, two cutouts loaded one after the other). Retry policy:
delays (1 s, 4 s), 90 s per attempt. The moving targets from the demo list
(3I/ATLAS, 4 Vesta) were left out because the viewer has no ephemeris support.

| Step | Requests | Final success | Latency p50 / p95 / max |
|---|---|---|---|
| Search: 2 SIA queries in parallel | 40 | 40/40 (100%) | 3.0 / 6.3 / 6.9 s |
| Load: 2 cutouts in sequence | 40 | 38/40 (95%) | 14.9 / 26.2 / 38.8 s per pair |

Server log for the whole server session (80 benchmark requests plus about 11
earlier ones):
- 35 requests hit a transient 502 or 503 and were retried.
- 7 of those needed the second retry, after 4 s.
- 3 failed for good: two exhausted all retries on `503 Server busy, retry later`,
  and one got IRSA HTTP 422.
- That is roughly 62% success on the first try and 97% after retries. 32 of the
  35 retried requests were rescued, 5 of them by the 4 s retry.
- The two failed cutouts (WISE 0855 2026-05-05 D1, M31 2025-07-09) were shown in
  the UI as "1/2 frames loaded" with the IRSA error. Fetched directly again
  afterwards, the WISE frame again returned 503 twice: IRSA load, not bad data.

Observations:
- Cutouts are the bottleneck, not metadata. A 3 arcmin cutout downloaded about
  4 MB, and each pair took about 15 s at the median.
- IRSA 422 responses are currently reported as "IRSA unavailable". They should be
  reported as a cutout problem.
- This is a single 7-minute sample at one time of day, so success rates will vary.

## After: S3 partial reads + parallel loading (same day, same 20 targets)

The same browser benchmark was re-run after two changes: pixels are now read from
IRSA's public AWS copy (only the rows covering the field), and the UI loads up to
4 cutouts at a time. Searches are unchanged and still query IRSA live.

| Step | Before (IRSA cutout service) | After (S3 partial read) |
|---|---|---|
| Load 2 frames, p50 / p95 / max | 14.9 / 26.2 / 38.8 s | **1.6 / 2.4 / 2.7 s** |
| Load 8 frames (5 targets) | ~35 s (manual test) | **3.9-4.7 s** |
| Cutout outcome | 38/40; 2 lost to `503 Server busy` | 39/40 from S3, 0 fallbacks to IRSA |
| Search (unchanged), p50 | 3.0 s | 2.6 s; 3 transient 502s, all rescued by retry |

The one frame not loaded (M31, 2025-07-09 D1) has no pixels covering the target.
Before the change, IRSA's 503 errors hid that. S3 and IRSA cutouts of the same
exposures were pixel-for-pixel identical, with identical wavelengths, on 4 Barnard
exposures (DR1 and QR3).

## Raw run output

The `spherex_dr1` D6 2026-05-05 cutout error below was a transient IRSA failure
during the run.

## Live verification run, 2026-11-14 18:50 UTC

### Barnard's Star (viewer sample, J2026 center)

Center RA 269.446268, Dec 4.768204; 3.0 arcmin field; motion source: SIMBAD (README).

| Collection | Status | Exposures | UTC dates | First | Last | Survey windows |
|---|---|---|---|---|---|---|
| `spherex_dr1` | ok | 252 | 27 | 2025-08-15 | 2026-05-05 | 2025-08-15..2025-10-01 (129); 2026-03-11..2026-05-05 (123) |
| `spherex_qr3` | ok | 128 | 14 | 2026-08-16 | 2026-09-22 | 2026-08-16..2026-09-22 (128) |
| `spherex_dr1_deep` | empty | 0 | 0 | - | - | - |
| `spherex_qr3_deep` | empty | 0 | 0 | - | - | - |

| Detector | `spherex_dr1` | `spherex_qr3` | `spherex_dr1_deep` | `spherex_qr3_deep` |
|---|---|---|---|---|
| D1 | 43 on 10 dates | 18 on 5 dates | none | none |
| D2 | 42 on 11 dates | 25 on 6 dates | none | none |
| D3 | 42 on 14 dates | 21 on 7 dates | none | none |
| D4 | 43 on 10 dates | 18 on 5 dates | none | none |
| D5 | 41 on 11 dates | 25 on 6 dates | none | none |
| D6 | 41 on 14 dates | 21 on 7 dates | none | none |

DR1/QR3 overlap: 0 observation IDs appear in both releases (129 DR1-only, 64 QR3-only).

Cutout spot checks (first/last exposure per collection and detector). Peak S/N is the brightest pixel within 2 native pixels of the predicted position; a neighbouring source can produce it, so it is a sanity check, not a detection. Any-FLAGS % counts every set bit, including source bits.

| Collection | Det | UTC | Coverage | Target offset E,N (arcsec) | In field | Peak S/N within 12" | lambda (um) | Any FLAGS % |
|---|---|---|---|---|---|---|---|---|
| `spherex_dr1` | D1 | 2025-08-27 | 100.0% | 0.3, -3.6 | yes | 6755.3 | 0.750 | 100.0 |
| `spherex_dr1` | D1 | 2026-03-11 | 99.3% | -0.2, 2.0 | yes | 2681.8 | 1.092 | 100.0 |
| `spherex_dr1` | D6 | 2025-08-15 | 100.0% | 0.3, -3.9 | yes | 8082.4 | 4.929 | 99.8 |
| `spherex_dr1` | D6 | 2026-05-05 | error: IRSA is unavailable or timed out. Please retry; no data were substituted. | | | | | |
| `spherex_qr3` | D1 | 2026-08-23 | 99.5% | -0.5, 6.7 | yes | 4588.8 | 0.776 | 100.0 |
| `spherex_qr3` | D1 | 2026-09-02 | 99.6% | -0.5, 6.9 | yes | 5707.6 | 0.758 | 100.0 |
| `spherex_qr3` | D6 | 2026-08-16 | 17.2% | -0.5, 6.5 | yes | - | - | 100.0 |
| `spherex_qr3` | D6 | 2026-09-22 | 18.2% | -0.6, 7.5 | yes | - | - | 100.0 |

### WISE 0855 (viewer sample = ~2010 reference position)

Center RA 133.795129, Dec -7.245147; 3.0 arcmin field; motion source: CatWISE2020 J085506.91-071437.5.

| Collection | Status | Exposures | UTC dates | First | Last | Survey windows |
|---|---|---|---|---|---|---|
| `spherex_dr1` | ok | 271 | 28 | 2025-05-05 | 2026-05-14 | 2025-05-05..2025-05-06 (30); 2025-10-31..2025-12-13 (139); 2026-04-21..2026-05-14 (102) |
| `spherex_qr3` | empty | 0 | 0 | - | - | - |
| `spherex_dr1_deep` | empty | 0 | 0 | - | - | - |
| `spherex_qr3_deep` | empty | 0 | 0 | - | - | - |

| Detector | `spherex_dr1` | `spherex_qr3` | `spherex_dr1_deep` | `spherex_qr3_deep` |
|---|---|---|---|---|
| D1 | 43 on 10 dates | none | none | none |
| D2 | 48 on 14 dates | none | none | none |
| D3 | 45 on 13 dates | none | none | none |
| D4 | 41 on 10 dates | none | none | none |
| D5 | 49 on 15 dates | none | none | none |
| D6 | 45 on 13 dates | none | none | none |

Cutout spot checks (first/last exposure per collection and detector). Peak S/N is the brightest pixel within 2 native pixels of the predicted position; a neighbouring source can produce it, so it is a sanity check, not a detection. Any-FLAGS % counts every set bit, including source bits.

| Collection | Det | UTC | Coverage | Target offset E,N (arcsec) | In field | Peak S/N within 12" | lambda (um) | Any FLAGS % |
|---|---|---|---|---|---|---|---|---|
| `spherex_dr1` | D1 | 2025-05-06 | 100.0% | -122.2, 9.0 | NO | - | 0.994 | 41.7 |
| `spherex_dr1` | D1 | 2026-05-05 | 100.0% | -130.0, 9.5 | NO | - | 0.963 | 42.6 |
| `spherex_dr1` | D6 | 2025-05-05 | 99.5% | -122.1, 9.0 | NO | - | 4.968 | 37.0 |
| `spherex_dr1` | D6 | 2026-05-11 | 99.5% | -130.2, 9.5 | NO | - | 4.968 | 36.2 |

### WISE 0855 (propagated to 2026.0 with CatWISE2020 motion)

Center RA 133.759470, Dec -7.242557; 3.0 arcmin field; motion source: CatWISE2020 J085506.91-071437.5.

| Collection | Status | Exposures | UTC dates | First | Last | Survey windows |
|---|---|---|---|---|---|---|
| `spherex_dr1` | ok | 259 | 27 | 2025-05-05 | 2026-05-14 | 2025-05-05..2025-05-06 (30); 2025-10-31..2025-12-13 (128); 2026-04-21..2026-05-14 (101) |
| `spherex_qr3` | empty | 0 | 0 | - | - | - |
| `spherex_dr1_deep` | empty | 0 | 0 | - | - | - |
| `spherex_qr3_deep` | empty | 0 | 0 | - | - | - |

| Detector | `spherex_dr1` | `spherex_qr3` | `spherex_dr1_deep` | `spherex_qr3_deep` |
|---|---|---|---|---|
| D1 | 37 on 8 dates | none | none | none |
| D2 | 48 on 14 dates | none | none | none |
| D3 | 45 on 13 dates | none | none | none |
| D4 | 36 on 8 dates | none | none | none |
| D5 | 48 on 14 dates | none | none | none |
| D6 | 45 on 13 dates | none | none | none |

Cutout spot checks (first/last exposure per collection and detector). Peak S/N is the brightest pixel within 2 native pixels of the predicted position; a neighbouring source can produce it, so it is a sanity check, not a detection. Any-FLAGS % counts every set bit, including source bits.

| Collection | Det | UTC | Coverage | Target offset E,N (arcsec) | In field | Peak S/N within 12" | lambda (um) | Any FLAGS % |
|---|---|---|---|---|---|---|---|---|
| `spherex_dr1` | D1 | 2025-05-06 | 100.0% | 5.2, -0.3 | yes | 32.1 | 0.993 | 42.4 |
| `spherex_dr1` | D1 | 2026-05-05 | 100.0% | -2.7, 0.2 | yes | 41.2 | 0.962 | 42.6 |
| `spherex_dr1` | D6 | 2025-05-05 | 100.0% | 5.2, -0.3 | yes | 2.3 | 4.967 | 38.7 |
| `spherex_dr1` | D6 | 2026-05-11 | 100.0% | -2.8, 0.2 | yes | 3.8 | 4.967 | 37.7 |

