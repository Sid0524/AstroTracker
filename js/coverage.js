// Coverage reporting: which releases were searched, whether coverage is known,
// and a dates x detectors chart of what the index holds for a position.

export const DETECTOR_IDS = [1, 2, 3, 4, 5, 6];
const WINDOW_GAP_DAYS = 30;
const DAY_MS = 86400000;
const TAP_PX = 20; // a tap this close to a mark selects it (marks are 4 px wide)

// Release of an exposure: decodeRow sets `release`; fall back to the S3 path.
export function releaseOf(exposure) {
  if (exposure.release) return exposure.release;
  const match = exposure.url?.match(/\/((?:dr|qr)\d+)\/level2\//);
  return match ? match[1] : 'unknown';
}

const label = release => release.toUpperCase();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const utcDay = exposure => new Date(exposure.date ?? (exposure.mjd - 40587) * DAY_MS).toISOString().slice(0, 10);

// Groups exposures by detector, UTC day and release, sorted by time.
export function groupCoverage(exposures) {
  const groups = new Map();
  for (const e of exposures) {
    const day = utcDay(e), release = releaseOf(e);
    const key = `${e.detector}|${day}|${release}`;
    if (!groups.has(key)) groups.set(key, { key, detector: e.detector, day, release, mjd: e.mjd, count: 0 });
    const g = groups.get(key);
    g.count++;
    g.mjd = Math.min(g.mjd, e.mjd);
  }
  return [...groups.values()].sort((a, b) => a.mjd - b.mjd || a.detector - b.detector);
}

// Clusters of dates less than 30 days apart (one per six-monthly sky pass).
export function surveyWindows(exposures) {
  const mjds = exposures.map(e => e.mjd).sort((a, b) => a - b);
  const windows = [];
  for (const mjd of mjds) {
    const last = windows.at(-1);
    if (last && mjd - last.end <= WINDOW_GAP_DAYS) { last.end = mjd; last.count++; } else windows.push({ start: mjd, end: mjd, count: 1 });
  }
  return windows;
}

function scope(summary) {
  const names = summary?.collections?.map(c => label(c.name.replace(/^spherex_/, ''))) ?? [];
  const searched = names.length ? names.join(', ') : 'unknown releases';
  const f = summary?.freshness;
  const date = f?.status === 'known'
    ? `index updated ${f.updatedAt.slice(0, 10)}, ${plural(Math.floor(f.ageMs / DAY_MS), 'day')} ago`
    : 'index update time unknown';
  const dr1 = names.length && !names.includes('DR1') ? ' DR1 is not indexed yet, so reprocessed images may exist.' : '';
  return { searched, date, dr1 };
}

// Empty search: a real "no coverage" for the searched releases, never a claim about SPHEREx as a whole.
export function noCoverageMessage(summary, subject = 'this position') {
  const s = scope(summary);
  return `No SPHEREx exposures of ${subject} in the index (searched ${s.searched}; ${s.date}).${s.dr1}`;
}

// Some index tiles failed: results are incomplete, so coverage is partly unknown.
export function partialCoverageMessage(failed, total) {
  return `Coverage incomplete: ${failed} of ${plural(total, 'index tile')} failed to load, so some dates may be missing. Search again to retry.`;
}

// No cutouts loaded: failed downloads are "not confirmed", only off-image visits are "no usable cutouts".
export function noCutoutsMessage(frames) {
  const failed = frames.filter(f => f.failed).length;
  if (failed) return `${failed} of ${plural(frames.length, 'visit')} could not be downloaded (network or archive error), so this is not confirmed as missing data. Search again to retry.`;
  return 'No usable cutouts: the target is outside the usable image area in every visit. Try a wider field or another detector.';
}

// After loading: visits with nothing downloaded are missing from this view;
// visits with some failed exposures are still shown, with fewer exposures. '' if none failed.
export function partialDownloadMessage(frames) {
  const missing = frames.filter(f => f.failed && f.status === 'error').length;
  const reduced = frames.filter(f => f.failed && f.status !== 'error').length;
  if (!missing && !reduced) return '';
  const n = frames.length;
  if (!missing) return `${reduced} of ${plural(n, 'visit')} ${reduced === 1 ? 'is' : 'are'} shown with fewer exposures because some downloads failed. Search again to retry.`;
  const more = reduced ? ` ${reduced} more ${reduced === 1 ? 'is' : 'are'} shown with fewer exposures.` : '';
  return `${missing} of ${plural(n, 'visit')} could not be downloaded; ${missing === 1 ? 'it is' : 'they are'} missing from this view, not confirmed missing from the archive.${more} Search again to retry.`;
}

// One line describing what was found and from which releases.
export function coverageSummary(exposures, summary) {
  const releases = new Map();
  for (const e of exposures) releases.set(releaseOf(e), (releases.get(releaseOf(e)) || 0) + 1);
  const parts = [...releases].sort().map(([r, n]) => `${label(r)} ${n}`).join(', ');
  const days = new Set(exposures.map(utcDay)).size;
  const windows = surveyWindows(exposures).length;
  const s = scope(summary);
  return `${plural(exposures.length, 'exposure')} on ${plural(days, 'UTC date')} in ${plural(windows, 'survey window')} (${parts}). Searched ${s.searched}; ${s.date}.${s.dr1}`;
}

// Index of the frame closest in time to mjd (earliest on ties), or -1 if none.
export function nearestIndex(frames, mjd) {
  let best = -1;
  frames.forEach((f, i) => { if (best < 0 || Math.abs(f.mjd - mjd) < Math.abs(frames[best].mjd - mjd)) best = i; });
  return best;
}

// Renders the dates x detectors chart into root. onPick(detector, mjd) on click/Enter/Space.
export function renderCoverage(root, { exposures, band, detectors = {}, onPick }) {
  const doc = root.ownerDocument;
  root.replaceChildren();
  if (!exposures.length) return;
  const groups = groupCoverage(exposures);
  let t0 = Infinity, t1 = -Infinity;
  for (const e of exposures) { t0 = Math.min(t0, e.mjd); t1 = Math.max(t1, e.mjd); }
  const pad = Math.max(2, (t1 - t0) * 0.03);
  t0 -= pad; t1 += pad;
  const pct = mjd => `${(100 * (mjd - t0)) / (t1 - t0)}%`;
  for (const det of DETECTOR_IDS) {
    const row = doc.createElement('div');
    row.className = `cov-row${det === band ? ' active' : ''}`;
    const name = doc.createElement('span');
    name.className = 'cov-label';
    name.textContent = detectors[det]?.name ?? `D${det}`;
    const lane = doc.createElement('div');
    lane.className = 'cov-lane';
    for (const w of surveyWindows(exposures)) {
      const shade = doc.createElement('span');
      shade.className = 'cov-window';
      shade.style.left = pct(w.start);
      shade.style.width = `calc(${pct(w.end)} - ${pct(w.start)})`;
      lane.append(shade);
    }
    for (const g of groups.filter(g => g.detector === det)) {
      const mark = doc.createElement('button');
      mark.type = 'button';
      mark.className = `cov-mark rel-${g.release}`;
      mark.style.left = pct(g.mjd);
      mark.title = `${g.day}, ${name.textContent}, ${label(g.release)}: ${plural(g.count, 'exposure')}`;
      mark.setAttribute('aria-label', `${mark.title}. Show this date.`);
      mark.addEventListener('click', () => onPick?.(det, g.mjd));
      lane.append(mark);
    }
    // Taps between marks select the nearest one within TAP_PX (fingers are wider than marks).
    lane.addEventListener('click', e => {
      if (e.target.closest?.('.cov-mark')) return;
      const box = lane.getBoundingClientRect();
      let best = null, bestPx = TAP_PX;
      for (const m of lane.querySelectorAll('.cov-mark')) {
        const px = Math.abs(box.left + (Number.parseFloat(m.style.left) / 100) * box.width - e.clientX);
        if (px <= bestPx) { best = m; bestPx = px; }
      }
      best?.click();
    });
    row.append(name, lane);
    root.append(row);
  }
}
