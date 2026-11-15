# Data sources and limitations

What the viewer reads, how it decides what to trust, and what it cannot tell you.
For live results on the challenge targets, see [VERIFICATION.md](VERIFICATION.md).

## Sources

| Data | Service | How it is used |
|---|---|---|
| Observation metadata | IRSA Simple Image Access, `https://irsa.ipac.caltech.edu/SIA` | `COLLECTION=<name>`, `POS=CIRCLE ra dec r`, `RESPONSEFORMAT=VOTABLE`, `MAXREC=1501`. The radius `r` is the circle that encloses the square field. |
| Image pixels (preferred) | IRSA's public AWS copy, `https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/<key>` | The bucket and key come from each SIA row's `cloud_access` column. Only the IMAGE and FLAGS rows covering the field are read, with HTTP range requests through astropy and fsspec, and repackaged with shifted WCS reference pixels. Each frame reports `source: s3`. |
| Image cutouts (fallback) | IRSA on-premises FITS, `https://irsa.ipac.caltech.edu/ibe/data/spherex/{dr1,qr3}/level2/...` | The `access_url` from SIA plus `?center=ra,dec&size=1.5*fov`. The `IMAGE`, `FLAGS` and WCS headers are read; nothing is stored on disk. |
| Target wavelength | Alternate `W` WCS in each cutout's `IMAGE` header | The central wavelength and bandwidth at the target pixel, which differ from exposure to exposure even within one detector. |
| Sample target positions | SIMBAD (Barnard's Star), CatWISE2020 via IRSA Gator (WISE 0855) | Fixed field centers propagated to about 2026.0 with catalog proper motions. See below. |

Collections queried: `spherex_dr1` and `spherex_qr3`, plus `spherex_dr1_deep` and
`spherex_qr3_deep` when "Include deep-survey collections" is checked. QR2 is not queried.

**DR1 and QR3 are complementary, not duplicates.** For Barnard's Star, DR1 has
exposures from 2025-08-15 to 2026-05-05 and QR3 from 2026-08-16 to 2026-09-22, with
no shared observation IDs. Searching only one release gives a shorter time baseline.

### Adding a new release

1. Add the collection name(s) to `COLLECTIONS` in `app.py`.
2. Allow its path in the `cutout_url()` regex (`(dr1|qr3)` becomes `(dr1|qr3|newname)`).
3. Add it to the release `<select>` in `static/index.html` and to the `release`
   check in `search()`.
4. Run `python tools/verify_releases.py --deep` and add the output to VERIFICATION.md.

## How each collection's result is classified

Every search returns `collection_status`, one entry per collection queried. The
timeline shows each entry as a chip, and any status other than `ok` or `empty` is
also listed under warnings.

| Status | Meaning | What the user sees |
|---|---|---|
| `ok` | IRSA answered and every row was usable. | "DR1 252 exposures" |
| `empty` | IRSA answered with zero overlapping exposures. This is a real "no coverage". | "QR3 searched: no exposures here" |
| `partial` | Some rows were malformed (missing time, wavelength or detector) and were skipped. | Amber chip and a warning with the count of skipped rows |
| `truncated` | More than 1,500 rows, or IRSA reported `OVERFLOW`. Later rows are missing. | Amber chip and "narrow the search" |
| `failed` | Network error, HTTP error, timeout, cut-off response, rejected query, unreadable table, or every row unusable. Coverage is **unknown**. | Amber "query failed: coverage unknown" chip. If every collection failed, the search returns HTTP 502. |

A failed collection is never reported as "no coverage".

### Freshness of the S3 copy

The exposure list always comes from the live IRSA search, so new releases appear
immediately. S3 is used only for pixels of exposures whose SIA row names an AWS
copy. A missing or invalid `cloud_access`, an S3 error, or a timeout (30 s) falls
back to the IRSA cutout service. If a field is off the exposure, the request
returns 422 without trying IRSA.

### Retries and limits

- HTTP 429/502/503/504 and responses cut off mid-download get **two retries**
  (after 1 s and 4 s). Other HTTP errors, such as 500 and 404, fail immediately.
  IRSA's proxy was seen returning 502 several times within a second on
  2026-11-14, which a single 1 s retry did not survive.
- Each IRSA request times out after 90 seconds. At most 3 IRSA requests and 8 S3
  reads run at once. The UI loads 4 cutouts in parallel and allows 32 selections.
  The server caches 64 aligned frames.
- Metadata responses are capped at 8 MB and cutouts at 16 MB.
- Cutout URLs must be HTTPS on `irsa.ipac.caltech.edu` under the SPHEREx DR1/QR3
  level-2 paths. Anything else is blocked.

## Known limitations

**Coverage and footprints**
- An SIA match means the exposure footprint overlaps the search circle, **not**
  that the target has usable pixels. For Barnard's Star, QR3 D6 cutouts had only
  17-18% finite coverage and did not reach the target, and one QR3 D3 exposure
  returned no usable cutout at all. Check each frame's coverage and
  "Target in footprint" after loading.
- Rows are exposures, not independent visits. A single date often has several
  overlapping exposures in the same detector.
- The record cap is 1,500 per collection. Large fields near survey overlap regions
  can hit it.

**Moving targets**
- The field center is fixed. Fast movers can leave the field: WISE 0855 moves about
  8 arcsec/yr west, so the challenge's reference position (08h55m10.831s
  -7d14m42.53s, an epoch-2010 position) is **122-130 arcsec** from the object in
  2025-26. That is outside the default 3 arcmin view (half-width 90 arcsec). The
  "WISE 0855 (2026 position)" sample uses a CatWISE2020-propagated center instead.
  The reference position is still available as a separate sample.
- Proper-motion propagation is linear and ignores parallax. Parallax is under
  0.6 arcsec for both samples, which is under 0.1 SPHEREx pixel.

**Image content**
- Native pixels are about 6.15 arcsec. Display resampling to 128x128 adds no resolution.
- Each detector covers a wavelength range, so two frames from the same detector are
  not taken through the same filter. Brightness differences can come from
  wavelength, not change.
- The FLAGS percentage counts any set bit, including source-detection bits. It is
  not a bad-pixel fraction; bright fields show 100%.
- No quality mask, zodiacal-light subtraction, cross-frame photometric
  calibration, PSF matching or registration beyond the archive WCS is applied.
- WISE 0855 is extremely red. In single D6 exposures, the brightest pixel near its
  predicted position is only about 2-4 sigma above the background. Stacking would
  be needed to see it reliably.

**Operations**
- IRSA availability varies. Failures are reported, not hidden, but a search may
  need a manual retry.
- Some machines lack the "SSL.com TLS RSA Root CA 2022" certificate that IRSA's
  chain ends in. Python then fails with `CERTIFICATE_VERIFY_FAILED`. On Windows,
  opening <https://irsa.ipac.caltech.edu> once in Edge or PowerShell
  (`Invoke-WebRequest`) usually installs the root automatically.
- Caches are in memory only: 8 searches, 16 frames, and a 1-hour search lifetime.

## SpaceLapse (deployed app)

| Data | Source |
|---|---|
| Exposure list | Static index `data/index.json` + `data/tiles/*.bin`, built weekly by `tools/build_index.py` from IRSA TAP |
| Pixels, FLAGS, wavelength | IRSA's public S3 copy, partial reads in the browser |

- **Coverage messages:** an empty search names the searched releases and the index
  date. Failed index tiles are reported as incomplete or unknown coverage, never as
  "no images".
- **Coverage panel:** dates by detector and release. Click a mark to switch
  detector or jump to the nearest loaded date.
- **Limits:**
  - The index can be up to a week old.
  - DR1 fills in over several weekly runs.
  - QR2 entries are superseded processing until DR1 replaces them.
  - A footprint match is not guaranteed usable pixels.
- **Rebuilding:** see [INDEX_REBUILD.md](INDEX_REBUILD.md).
- **Builder reliability:** `--max-minutes` stops starting new folders when time
  runs out. Failed and deferred folders stay incomplete for the next run, and
  are listed in `refreshProvenance`.

## Official references

- [SPHEREx data access](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-access/)
- [SPHEREx data products](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/)
- [IRSA SPHEREx mission page](https://irsa.ipac.caltech.edu/Missions/spherex.html)
- [IRSA SPHEREx tutorial notebooks](https://caltech-ipac.github.io/irsa-tutorials/spherex/)
