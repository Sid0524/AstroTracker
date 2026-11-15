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

## Person 1 checklist (2026-11-14)

| Item | Flask viewer | SpaceLapse (deployed) |
|---|---|---|
| 1. Verify DR1/QR3 for Barnard's Star and WISE 0855; dates, coverage, missing-release behavior | Done: live IRSA (VERIFICATION.md) | QR3 done; **DR1 pending index rebuild** (INDEX_REBUILD.md); missing-release messages done |
| 2. Observation timeline (dates and detectors) | Done | Done (Archive coverage panel) |
| 3. Tests for empty, partial and failed responses; data sources and limits | Done | Done |
| Consideration: easy to update with new releases | Done (steps in DATA_SOURCES.md) | Done (weekly builder with time budget) |
| Consideration: field of view, URL coordinates, contamination flags | Done (tested) | Teammate's features, covered by their tests |

Live browser checks on the same day: both apps searched Barnard's Star; timeline
and coverage clicks switched detector and jumped to the chosen date; SpaceLapse
tracked 3I/ATLAS. Not yet seen running on GitHub: `tests.yml` and the
`--max-minutes` change in `update-index.yml` (the budget is guarded by a test).
Out of Person 1 scope: image addition/subtraction (Person 2), catalog overlays
and sharing (Person 3).

### SpaceLapse walkthrough (2026-11-14)

Every control was exercised in the browser, except PNG, Video and Export JSON
(they download files):
- landing guide, settings (Cancel discards, Save keeps)
- demo slider, target cards, five-target checks
- detectors, six view modes, field sizes
- play/pause, prev/next, speed, filmstrip, blink A/B
- stretch, colour map, invert, crosshair, mask, quality overlay
- coverage chart, archive panel, view link, change scan

No console errors.

**Found and fixed:** "Run five target checks" failed for every target
(`findExposures is not defined`, a regression from this branch). It is now
covered by `tests/js/spacelapse-checks.test.cjs`, and check reports also flag
failed index tiles.

**Also fixed:** the WISE 0855 and Epsilon Indi B caveats now say the object is
about 2 arcmin from the fixed center.

**Flagged, not fixed:**
- View links encode exact QR2 file paths, so links made before DR1 is indexed
  may not restore their exact dates afterwards (sharing is Person 3's area).
- "Source on GitHub" points to `ShivenKhurana1/spherex-timelapse`.

Test tags: **O1-O3** challenge objectives, **C** potential considerations,
**P1** Person 1 tasks, **UI** expected behavior of a UI control.

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

## SpaceLapse (deployed app)

| Requirement | Tests |
|---|---|
| **P1.1** Releases searched and DR1 handling | `tests/coverage.test.js` (messages, DR1 caveat); `test_build_index.py` (DR1 parsing, newest version, retries) |
| **P1.2** Dates by detector chart | `tests/js/spacelapse.test.cjs` (rows, marks, windows, clicks); `tests/js/spacelapse-search.test.cjs` (real page + index, Barnard's Star) |
| **P1.3** Empty, partial and failed index | `tests/coverage.test.js` (catalog partial/all-failed/abort); `spacelapse-empty`, `-partial`, `-unreachable` page tests |
| New releases arrive despite slow IRSA | `test_build_index.py` (time budget, failure isolation, retry next run) |

`js/coverage.js`: 100% of lines and branches across both suites. `tools/build_index.py`: 98%.
Tests also found and fixed a builder bug: `--recent 0` re-fetched every folder.

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
| `test_build_index.py` | SpaceLapse index builder |
| `tests/coverage.test.js` | SpaceLapse coverage messages and catalog failures |
| `tests/js/spacelapse*.test.cjs` | SpaceLapse coverage chart and page |
