# SPHEREx Sky Viewer

A local, public-facing first-milestone interface for exploring real SPHEREx
infrared images over time. Python/Flask serves a dependency-free browser UI and
retrieves data directly from IRSA. No credentials, cloud account, or paid services.
This is not an official NASA/IRSA product or a discovery pipeline.

## Run (Windows PowerShell, Python 3.12+)

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe app.py
```

Open <http://127.0.0.1:8000>. If the environment already exists, only the last
command is needed. Stop the server with Ctrl+C. It binds only to localhost.
Flask's development server is for the local demo, not Internet deployment.

## First comparison

1. Leave Barnard's Star selected and click **Search this field**.
2. Keep D1, then click **Load selected (2)** to fetch the first and last available
   calendar dates in that detector band.
3. Click **Play** to blink A/B. Select additional exposures in the log (up to 8),
   reload, and choose **Time sequence** to step through all loaded frames.

Pin any loaded exposure as A or B using the log. The slider and arrow buttons
also inspect frames manually. Low/High adjust one shared asinh display stretch;
Auto calculates pooled 1st/99.5th percentile limits across all loaded frames.
Search parameters appear in the page URL for sharing locally; opening that URL
fills the form but does not start network downloads.

Supported: decimal ICRS RA/Dec, 1-12 arcmin square FOV, DR1/QR3/both, optional
deep-survey collections, all six detector bands, UTC exposure dates, collection,
detector-wide wavelength range, target-specific wavelength/bandwidth from the
FITS WCS-WAVE lookup table, pixel coverage, FLAGS fraction and FINAST metadata,
direct FITS links, and explicit loading/no-coverage/partial-failure/error states.

## Data path and limits

- Metadata uses <https://irsa.ipac.caltech.edu/SIA>, `POS=CIRCLE`, `COLLECTION`,
  `RESPONSEFORMAT=VOTABLE`, and `MAXREC=1501`. VOTable avoids ambiguous CSV quoting
  in IRSA's cloud-access metadata. Current collections are `spherex_dr1`,
  `spherex_qr3`, and their `_deep` variants. QR2 is not queried.
- Each collection is capped at 1,500 records, with a visible truncation warning.
  Failed collections remain visible as warnings, never interpreted as no coverage.
- Cutouts use the returned on-premises FITS URL with `center` and `size`; a 1.5x
  padded square covers detector rotation. Only selected exposures are downloaded,
  sequentially in the UI. No full-image or bulk downloads.
- FITS IMAGE data are bilinearly resampled using celestial TAN/SIP WCS onto the
  same 128x128 north-up/east-left TAN sky grid. Missing/nonfinite pixels are shown
  dark blue, not filled with invented image data. Every frame reports its finite
  coverage; footprint overlap in SIA does not guarantee usable target pixels.
- Target wavelength uses the alternate WCS-WAVE mapping, without accidentally
  applying the primary celestial SIP distortion to detector pixel coordinates.
- The server limits concurrent archive requests to 3, metadata responses to 8 MB
  and cutouts to 16 MB. Transient HTTP 429/502/503/504 gets one logged retry;
  individual network requests time out after 90 seconds. Searches can take longer
  for multiple collections or a retry. Errors allow manual reload/retry.
- In-memory caches retain at most 8 searches and 16 rendered frames; searches
  expire after one hour and restarting clears all caches. No raw FITS files are
  stored. Cutout fetch URLs are restricted to current IRSA spectral-image paths.

## Sample coordinates and scientific limitations

Barnard's Star is centered at approximately RA **269.446268**, Dec **4.768204**
degrees at J2026. This is an approximate space-motion propagation of SIMBAD's
J2000 coordinates (17:57:48.4984700685, +04:41:36.113879676), with
mu_RA*cos(Dec) = -801.551 and mu_Dec = 10362.394 mas/year, without a
distance/radial-velocity model. It is a convenient fixed field center, not
precision astrometry. Its J2000 position is over four arcmin away and would miss
the star in a default 3-arcmin view.
[SIMBAD source](https://simbad.u-strasbg.fr/simbad/sim-id?Ident=NAME%20Barnard%27s%20star&output.format=ASCII).
WISE 0855 uses the supplied reference position 133.7951292, -7.2451472 degrees;
its visibility and motion are not guaranteed.

Overlapping exposures are **not independent visits**. The first/last selection
uses distinct UTC calendar dates, not a visit grouping or coaddition.
SPHEREx native pixels are about 6.15 arcsec; display resampling adds no resolution.
A detector spans many narrow wavelengths, so even same-detector frames are not
matched filters. Always inspect the target-specific wavelength and bandwidth.
Different wavelength, PSF, background, quality flags and astrometric residuals can
produce apparent changes. Finite pixels are not necessarily good science pixels.
FLAGS includes source bits: the fraction shown is not a bad-pixel fraction.
No quality mask, zodiacal-background subtraction, photometric calibration across
frames, PSF matching or precision image registration beyond archive WCS is applied.
Missing Gaia matches do not establish Planet X; this app makes no discovery claims.

Deferred: Gaia/WISE overlays, subtraction/addition, detailed 102-channel controls,
spectra, motion fitting, production deployment and survey-scale search.

## Checks

```powershell
.\.venv\Scripts\python.exe -m unittest -q
```

Focused offline tests cover validation, release selection, empty/partial/error
responses, truncation, VOTable metadata, constrained cutout URLs, missing pixels,
rotation/orientation, wavelength units and cache expiry. The core should also be
checked against live IRSA because archive coverage and availability change.

On 2026-11-14, all 14 offline tests passed. The J2026 Barnard field returned
380 DR1/QR3 records at 3 arcmin. Browser checks loaded D1 cutouts from
2025-08-27, 2026-03-11 and 2026-09-02, verified A/B image changes and three-date
sequence navigation, and checked the 8-selection cap and invalid-stretch state.
The first/last frames had 100%/99.6% finite display coverage. A live QR3-only
WISE 0855 search returned zero records without errors. IRSA intermittently
returned 503 during cutout checks; the bounded retry/error paths handle this.
These checks establish viewer operation, not a scientific motion detection.

Official references:
[Data access](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-access/),
[Data products](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/),
[Mission page](https://irsa.ipac.caltech.edu/Missions/spherex.html).
