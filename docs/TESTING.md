# Testing

All tests are offline: no IRSA or S3 access is needed.

```powershell
.\.venv\Scripts\python.exe -m coverage run -m unittest -q   # backend
.\.venv\Scripts\python.exe -m coverage report               # fails under 90%
npm ci; npm run test:viewer                                 # frontend (jsdom)
npm run coverage:viewer                                     # lines 90%, branches 80%
```

CI runs both suites on every push and PR (`.github/workflows/tests.yml`). The check
is **advisory**: it reports results and coverage but never blocks a merge. It
takes under about 2 minutes.

## Coverage (2026-11-14)

| Area | Files | Lines | Branches |
|---|---|---|---|
| Backend | `app.py`, `tools/*.py` | 100% | 99% |
| Frontend | `static/timeline.js`, `static/viewer.js` | 100% | 98.6% |

## What the tests check

Tests assert how the app *should* behave. Writing them this way turned up and
fixed: a crash when a download is cut off, a single bad row discarding a whole
release, singular/plural wording, and the tool's "exposure IDs" label (it counts
observation IDs).

| Requirement | Source | Tests |
|---|---|---|
| **O1** Enter RA/Dec for a patch of sky | Objective | `viewer.test.cjs` O1 tests; `test_app.py` input validation; `test_app_behavior.py` non-numeric input |
| **O2** Show a series of images "like a little video" | Objective | `viewer.test.cjs` O2: loading, time-sequence playback, blink A/B, prev/next/slider, shared stretch |
| **O3** Test targets (Barnard, Eps Indi B, WISE 0855, RW Aur, R Dra) | Objective | `viewer.test.cjs` O3 samples and RW Aur/Eps Indi coordinates; `test_tools.py` Barnard and WISE 0855 positions |
| Easy to update with new releases | Consideration | `test_s3.py` key validation; `test_data_quality.py` release scoping; `docs/DATA_SOURCES.md` steps |
| User-chosen field of view | Consideration | `viewer.test.cjs` FOV in URL and request; `test_app.py` FOV limits |
| Coordinates in the URL | Consideration | `viewer.test.cjs` URL prefill and shareable URL after search |
| Show metadata such as contamination flags | Consideration | `viewer.test.cjs` frame details (FLAGS %, wavelength, FINAST, pixel source) |
| **P1.1** Verify DR1/QR3; missing-release behavior | Person 1 | `test_tools.py`; `viewer.test.cjs` empty vs failed release; `docs/VERIFICATION.md` live runs |
| **P1.2** Observation timeline | Person 1 | `timeline.test.cjs` (chips, marks, windows, selection, keyboard, busy); `viewer.test.cjs` timeline-driven selection |
| **P1.3** Empty, partial and failed IRSA responses | Person 1 | `test_data_quality.py`; `test_app_behavior.py` busy/eviction; `viewer.test.cjs` failure states |
| Fast, reliable retrieval | Person 1 (extension) | `test_s3.py` partial read identical to full file, every fallback; `viewer.test.cjs` 4-way parallel loading in order, 32-frame cap |

## Files

| File | Covers |
|---|---|
| `test_app.py` | Original viewer core: validation, WCS alignment, cache |
| `test_data_quality.py` | IRSA response handling and per-release status |
| `test_s3.py` | S3 partial reads and fallbacks |
| `test_app_behavior.py` | Routing, limits, cache bounds, edge images |
| `test_tools.py` | Verification and benchmark tools |
| `tests/js/timeline.test.cjs` | Observation timeline component |
| `tests/js/viewer.test.cjs` | Viewer page driven through its controls |
