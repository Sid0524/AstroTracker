# SPHEREx Time-Lapse

**Upstream live deployment:** https://spherex-timelapse.vercel.app

Local worktree changes are not published to that deployment automatically.

A public web tool for watching the sky change in NASA SPHEREx images.

Type an object name or coordinates, pick a detector band, and the app gathers every
SPHEREx exposure that covers that spot, aligns them on a common north-up grid, and lets
you **play them as a movie**, **blink** two epochs, or view their **difference**: the
fastest way to spot asteroids, comets, high-proper-motion stars and variable sources.

No install, no account, no backend. Everything runs in the browser.

## Features

- **Views:** time-lapse, blink, guarded A/B residual, exploratory median difference,
  motion trail (residual light coloured by date), and a deep median stack.
- **Follow a moving object:** switch the search to *Moving object* and type a comet or
  asteroid (3I/ATLAS, 12P, Ceres, 2024 YR4…). Every SPHEREx image along its path is cut
  out centred on where it was at that moment, so it stays put while stars stream by;
  *Deep stack* then adds up the object with the stars removed. Featured objects use
  JPL Horizons positions computed as seen from SPHEREx
  ([`tools/build_tracks.py`](tools/build_tracks.py), refreshed weekly); anything else
  uses IMCCE Miriade live.
- **Scan for changes:** screens visits for compatible wavelength and quality before
  looking for compact sources that appear or brighten,
  rejects one-exposure glitches (cosmic rays, satellite glints) by checking each
  exposure within a visit, and matches the rest against known asteroids. Detections
  are then linked into **moving-object tracklets**: slow movers (distant asteroids,
  Kuiper-belt objects, far-off comets) across several visits, and fast movers
  (near-Earth objects) across the exposures of a single visit.
  Anything left unexplained has a **Report** button that opens a prefilled GitHub
  issue (labelled `candidate`) with its position, date, images and a link to the view.
- **Archive coverage:** dates by detector and release, with the releases searched and
  index date. Failed index tiles show as incomplete coverage, not as "no images".
- **Known asteroids** labelled on each frame, from IMCCE's SkyBoT service.
- **Light curves and spectra:** click any star to plot its brightness at every visit,
  or switch to *Spectrum* to measure it in every exposure across all six bands and
  plot brightness against wavelength (0.75–5 µm). Wavelengths come from each file's
  `WCS-WAVE` lookup table (the filter's colour varies across the detector), which is
  also shown for every visit. CSV export for both.
- **Bad-pixel masking** from SPHEREx's own FLAGS layer (cosmic rays, hot pixels,
  persistence), decoded in the browser. Display masking is intentionally more
  permissive than the analysis mask; missing FLAGS leaves browsing available but
  prevents analysis.
- Shareable links, PNG and video export, keyboard controls (← → space, `b`, `d`).
- **Getting started:** a before/after slider demonstrates a moving point using
  clearly labelled simulated images. It supports touch and keyboard input; **Show
  me** marks the point in both views. Three featured destinations lead to the
  interstellar comet, Orion Nebula, and Galactic Center; other examples remain
  under **More places and objects**, alongside the five challenge targets.
- **Space-themed interface:** decorative background stars respond gently to the
  mouse. Touch and reduced-motion views keep the backdrop still. A connected
  three-step guide explains the basics, with extra tool explanations available
  on demand. Decorative effects never alter archive images or scientific outputs.
- **Target finder:** soft floating capsules replace the outer header frame.
  Choose **Stars & sky** or **Comets & asteroids**, enter a target, then **Explore**.
  **Quick start** opens the instructions without changing the shared-view URL.
  Pointer-reactive orbital lines, glow, and logo depth leave the search controls
  stationary; touch and reduced-motion views stay still. The header reflows on
  small screens, and content stays below its actual height.
- **View controls:** the open left rail shows all six views as labelled buttons,
  with short descriptions and no hidden modes. The six circular band
  buttons show wavelength and archive-image counts for the selected band.
  **How much sky?** changes the field of view. **Adjust the image** contains
  same-day grouping, display masking, brightness, colours, and overlays.
  There is no separate sidebar scrollbar; **Back to the image** returns from
  the rail to the viewer without changing the shared-view URL.
  The square image fits both the available width and screen height; **Fit image**
  brings it fully into view below the floating header without cropping the field.
  **Full screen** enlarges the complete image with playback and date-step buttons;
  use **Exit full screen** or Escape to return. Browser support is required.

## How it works

1. **Name → coordinates** via the CDS Sesame resolver.
2. **Find exposures** in a static, sky-tiled index of every SPHEREx Quick Release
   level-2 image (`spherex_qr2` + `spherex_qr3`, ~1.2 million detector images). The index
   lives in [`data/`](data/) and is rebuilt weekly from IRSA's TAP service by
   [`tools/build_index.py`](tools/build_index.py) in a GitHub Action. (IRSA's search APIs
   don't send CORS headers, so a browser can't query them directly.)
3. **Fetch only what's needed.** Each SPHEREx image is a ~66 MB multi-extension FITS
   file on the public `nasa-irsa-spherex` S3 bucket, which does allow CORS. The app
   reads the FITS header with an HTTP range request, solves the TAN-SIP WCS for the
   target, then range-reads just the image rows that contain the cutout (usually well
   under 1 MB).
4. **Reproject** every cutout onto the same tangent-plane grid centred on the target
   (6.15″ pixels, north up, east left), so stars stay put and moving things move.
5. **Mask** pixels SPHEREx flagged as bad. The app range-reads the relevant FLAGS
   rows, whether stored as an uncompressed 32-bit image or Rice-compressed tiles.
6. **Display** with a shared stretch across all epochs, with background (zodiacal
   light) removed per frame so the sky level doesn't flicker.

## Challenge workflows

- **Guided targets and live checks:** each official target has an observing guide
  and coordinate caveat. Open **Five challenge targets: guides & live checks** to
  run bounded archive smoke checks (up to three separated dates per target), cancel
  a run, or export timestamped JSON with counts, source URLs, failures and comparison
  availability. Results are saved in this browser, explicitly dated, and can become
  stale. These checks do not verify a detection, proper motion, variability or a
  period. Inspect the target manually and independently.
- **Wavelength window:** enter minimum and maximum wavelengths under the detector
  buttons. Every exposure contributing to a visit must have an approximate target
  wavelength inside the window; unknown wavelengths are excluded. Playback, stacks,
  the scan input and brightness plots use the filtered visits. Brightness plots also
  check the wavelength at the selected point, not just the field center. An empty
  selection clears the image rather than leaving the previous image visible.
  Changing the window resets A/B selections and scan results. **All wavelengths**
  clears the filter. This does not select precisely calibrated spectral channels
  or replace the stricter bandwidth/common-pixel checks for analysis.
- **Quality inspector:** below the filmstrip, inspect the current single visit's
  conservative valid support, flag-bit counts, approximate wavelengths/bandwidths,
  exposure failures and original FITS links. **Show rejected-pixel overlay** marks
  rejected native interpolation support and edges in orange; unavailable quality
  is never marked clean. Counts refer to output support samples across exposures,
  with overlapping categories, not independent contaminated native pixels.
  Use Time-lapse or Blink for the inspector and overlay, not a composite.
- **Reproducible sharing:** **Copy view link** records exact exposure identities for
  A/B/current dates, grouping, detector, field, wavelength window, display masking,
  stretch, colours, contrast, inversion, playback speed, frame limit, source probe
  and overlay choices. Saved visits that cannot be loaded are reported as
  unavailable instead of silently substituting another A/B visit.
  **Export observation JSON** includes settings and per-visit exposure URLs,
  actual cutout centers, metadata availability, quality summaries and loading
  exclusions. Links query the current index and orbit data, not a frozen archive;
  retain the JSON to preserve the original source paths and tracking centers.
- **Candidate export:** after a completed scan, **Candidate CSV** exports all
  candidates, including known-asteroid check state, glitches, sky coordinates,
  exposure identities and provenance. Scores are explicitly exploratory, not
  calibrated significance; a missing catalog response is not a negative match.
- **Gaia / WISE context:** under **Adjust the image**, choose **Gaia DR3** or
  **AllWISE** catalog markers for a single-date Time-lapse or Blink view. Gaia
  J2016.0 positions use linear proper motions when available (including the
  `pmRA*cos(dec)` convention), without parallax or radial-velocity corrections.
  Sources lacking proper motion retain their reference position and epoch.
  AllWISE markers are static, with no fabricated single observation epoch; J2000
  is a coordinate reference, not an observation date. Inspect per-source epoch
  information and W1/W2 magnitudes where present in **Catalog source details**.
  VizieR queries use a 0.05-degree margin and a 200-source cap per catalog;
  truncation, missing motions and service failures are explicit. This is not a
  complete catalog census or a WISE background-image layer. Pause moving-object
  playback to query the current field; **Retry catalog** retries a failed request.
- **Release provenance:** **Archive releases & freshness** reports the releases
  actually present in the local index and its timestamp. The index builder supports
  verified Quick Release and DR1 collection paths; adding support does not mean
  DR1 has already been indexed. Rebuild and publish the index to change coverage.
  Queries deduplicate overlapping releases by exposure and detector, preferring
  DR over QR and then the higher release number. Shared exposure keys also
  include the release/processing path so a reprocessed image is not silently
  substituted into an old comparison.

On 2026-11-14 UTC, a browser smoke run against the index updated
2026-11-10 loaded three sampled cutouts with FLAGS and WCS-WAVE for each of the
five challenge targets (D1 for Barnard's Star, RW Aurigae and R Draconis; D6 for
Epsilon Indi B and WISE 0855). None of those three-date samples contained two
mutually wavelength-compatible visits under the conservative comparison rule.
Browsing worked; guarded subtraction was unavailable for those samples. This
does not rule out compatible pairs elsewhere in the archive and is not evidence
of a detected object or measured variability.

## Comparison and science limitations

Select **A/B residual** in the view controls, and choose **A** or **B**
below the timeline. Then select a date on the timeline or filmstrip.
Shift-click also selects B.
The result is B − A. The scan selects and reports a mutually target-compatible subset of loaded visits,
then applies the same common-pixel safeguards to the entire subset. Groups with
failed exposures, missing FLAGS or WCS-WAVE, or internally incompatible wavelengths
are excluded. If too few remain, disable same-day grouping or select another detector.
Wavelength and bandwidth must each agree within 10% of the narrowest bandwidth,
at the target and across the retained common pixels. The analysis mask rejects all
flag bits except SOURCE (bit 21), including unknown bits. It requires all native
bilinear support pixels to be valid and guards image and mask boundaries. SOURCE
pixels remain usable for the image but are excluded from background estimation.
Offsets are estimated separately on common source-free support; at least 64 and
25% of grid pixels must overlap, with at least 64 source-free pixels and 10% of
the overlap available for background.

These are conservative **exploratory** checks, not calibrated matched-band
subtraction. WCS-WAVE is visualization-grade (approximately 1 nm), not precision
CWAVE/CBAND calibration; PSF matching, precision registration and a calibrated
noise model are not provided. Residual scores and candidates are not detection
significances. The median-difference, motion and stack views still combine visits
without spectral matching and are visualization only. Light curves and spectra are
exploratory, not calibrated photometry. Independently verify any apparent change.

The [challenge](https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/)
presets use fixed centers, not propagated positions: Barnard's Star is an
approximate 2026 center (269.446268°, +4.768204°); Epsilon Indi B is the
[CDS Sesame J2000 reference](https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV?eps%20Ind%20B)
(331.04414658852124°, −56.78284419511611°), not Epsilon Indi A, and Ba/Bb are
unresolved; WISE 0855 uses the challenge reference (133.7951292°, −7.2451472°).
These high-proper-motion objects may be displaced; WISE 0855 uses a wider field.
RW Aurigae ([Sesame](https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV?RW%20Aur),
76.95652603458°, +30.40143817389°) and R Draconis
([Sesame](https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV?R%20Dra),
248.16761083295°, +66.75497941722°) also use J2000 reference centers. All fields
are specified in image pixels at 6.15 arcsec/pixel, not arcminutes.

## Running locally

It's a static site, so any file server works:

```bash
python3 -m http.server 8000
```

then open <http://localhost:8000>.

## Tests

```bash
npm test
```

Offline unit tests (no network) for the WCS against astropy, the FLAGS Rice decoder
bit-for-bit against astropy, sky-tile keys shared with the Python index builder,
coordinate parsing, ephemeris interpolation and change detection. Fixtures in
`tests/fixtures/` come from a real SPHEREx file. CI runs them on every push.

## Rebuilding the index

```bash
python3 tools/build_index.py            # incremental: new + most recent folders
python3 tools/build_index.py --refresh all
python3 tools/build_tracks.py           # featured comet/asteroid tracks from JPL Horizons
python3 tools/validate_targets.py       # footprint counts + one FITS HEAD per target
python3 tools/validate_targets.py --no-head  # offline index-footprint check only
```

Standard library only; the first full build takes about an hour.
The CLI target check does not inspect cutouts or FLAGS. Use the browser's
five-target checks for bounded cutout/metadata validation, and still inspect the
objects manually. Shared metadata downloads are timeout-bounded; cancelling a
target check does not cancel another view's in-flight cached request.

## Flask viewer (data quality)

`app.py` and `static/` are a separate local viewer that queries IRSA live and
reads pixels from IRSA's public S3 copy. It shows per-release status (a failed
release reads as "coverage unknown", not "no coverage") and an observation
timeline of dates by detector.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe app.py   # http://127.0.0.1:8000
```

- Data sources and limits: [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md)
- DR1/QR3 checks and benchmarks: [docs/VERIFICATION.md](docs/VERIFICATION.md)
- Tests (`python -m unittest`, `npm run test:viewer`): [docs/TESTING.md](docs/TESTING.md)
- Rebuilding the SpaceLapse index (e.g. for DR1): [docs/INDEX_REBUILD.md](docs/INDEX_REBUILD.md)

### ESA Gaia credit

The optional Gaia DR3 overlay uses data from the European Space Agency mission Gaia.

> This work has made use of data from the European Space Agency (ESA) mission Gaia (https://www.cosmos.esa.int/gaia), processed by the Gaia Data Processing and Analysis Consortium (DPAC, https://www.cosmos.esa.int/web/gaia/dpac/consortium). Funding for the DPAC has been provided by national institutions, in particular the institutions participating in the Gaia Multilateral Agreement.

The Gaia data are open and free to use, provided credit is given to 'ESA/Gaia/DPAC'.

Gaia data are distributed under CC BY-NC 3.0 IGO (ESA terms: https://www.cosmos.esa.int/web/esdc/terms-and-conditions). This viewer is a non-commercial demo; no licence ruling has been sought from ESA.

Citations:

- Gaia Collaboration et al. (2016b): The Gaia mission. Astronomy & Astrophysics, 595, A1. https://doi.org/10.1051/0004-6361/201629272
- Gaia Collaboration et al. (2023j): Gaia Data Release 3. Summary of the content and survey properties. Astronomy & Astrophysics, 674, A1. https://doi.org/10.1051/0004-6361/202243940

## Data credit

SPHEREx data are provided by NASA/JPL-Caltech and served by the NASA/IPAC Infrared
Science Archive (IRSA). Featured tracks from JPL Horizons; other orbits and asteroid
positions from IMCCE's Miriade and SkyBoT; name lookup from
CDS Sesame. This project is not affiliated with NASA.
