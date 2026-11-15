import { resolve, formatRA, formatDec } from './resolve.js';
import { findExposuresDetailed, findAlongPath, DETECTORS, loadIndex, summarizeIndex } from './catalog.js';
import { renderCoverage, coverageSummary, noCoverageMessage, partialCoverageMessage, nearestIndex } from './coverage.js';
import { ephemeris, positionAt } from './ephem.js';
import { makeCutout, PIXEL_ARCSEC } from './cutout.js';
import { tanDeproject, tanProject, D2R } from './wcs.js';
import { knownObjects } from './asteroids.js';
import { wavelengthAt, waveTable, lookup } from './wave.js';
import { prepareComparison, selectCompatibleFrames } from './analysis.js';
import { findChanges, crop, linkAcrossVisits, linkWithinVisits } from './detect.js';
import { frameKey, spectrumAtCut, inWavelengthWindow, wavelengthWindow, qualitySummary, flagLabel, candidateCSV, encodeSettings, decodeSettings } from './observations.js';
import { CHALLENGE_GUIDES, challengeGuide, validateTarget } from './challenge.js';
import { fetchContext, projectContextSources } from './context.js';
import { snapToPeak, photometry, renderChart, toCSV, renderSpectrum, spectrumCSV, colourCorrect } from './lightcurve.js';
import {
  backgroundSubtract, medianStack, subtract, stretchLimits, paint, paintDiff, paintMotion, median,
} from './render.js';

const $ = id => document.getElementById(id);

const EXAMPLES = [
  { name: 'Interstellar comet 3I/ATLAS', track: '3I/ATLAS', note: 'Follow the third known interstellar visitor', size: 96, band: 1,
    feature: 'comet', headline: 'Follow a visitor from another star', invitation: 'Explore the path of interstellar comet 3I/ATLAS.' },
  { name: "Barnard's Star", ra: 269.446268, dec: 4.768204, note: 'Approximate 2026 fixed center; high proper motion', size: 96 },
  { name: 'Epsilon Indi B', ra: 331.04414658852124, dec: -56.78284419511611, note: 'J2000 fixed center; high proper motion; Ba/Bb unresolved', size: 160 },
  { name: 'WISE 0855', ra: 133.7951292, dec: -7.2451472, note: 'Challenge reference center; high proper motion; use a wide field', size: 240 },
  { name: 'RW Aurigae', ra: 76.95652603458, dec: 30.40143817389, note: 'J2000 fixed reference center', size: 96 },
  { name: 'R Draconis', ra: 248.16761083295, dec: 66.75497941722, note: 'J2000 fixed reference center', size: 96 },
  { name: 'Asteroid 4 Vesta', ra: 215.95, dec: -6.76, note: 'Caught crossing the field, July 2025', size: 240, band: 2, mode: 'motion' },
  { name: 'Pluto’s field, Oct 2025', ra: 304.138, dec: -23.617, note: 'Explore a field visited by Pluto', size: 96, band: 1 },
  { name: 'North Ecliptic Pole', ra: 270.0, dec: 66.5607, note: 'SPHEREx deep field: hundreds of visits' },
  { name: 'Crab Nebula', ra: 83.6331, dec: 22.0145, note: 'Wreck of a star that exploded in 1054', size: 160 },
  { name: 'Orion Nebula', ra: 83.8221, dec: -5.3911, note: 'Star nursery glowing in infrared', size: 240,
    feature: 'nebula', headline: 'Visit a place where stars are born', invitation: 'Look inside the Orion Nebula in infrared.' },
  { name: 'Galactic Center', ra: 266.4168, dec: -29.0078, note: 'The crowded heart of the Milky Way',
    feature: 'galaxy', headline: 'Look towards the heart of our galaxy', invitation: 'Explore the crowded star fields of the Milky Way.' },
  { name: 'South Ecliptic Pole', ra: 90.0, dec: -66.5607, note: 'Second deep field, near the LMC' },
];

const MODE_NAMES = { play: 'time-lapse', blink: 'blink', compare: 'A/B residual', diff: 'difference', motion: 'motion trail', static: 'deep stack' };

const MODE_HINTS = {
  play: 'Every visit in date order. Press play or use ← → keys.',
  blink: 'Flips between two dates. Select A or B below the timeline, then choose a date.',
  compare: 'Exploratory B − A. Select A or B below the timeline, then choose a date; quality and wavelength checks apply.',
  diff: 'Exploratory date minus median of all visits; wavelengths and quality may differ.',
  motion: 'Exploratory residuals across all visits; wavelengths and quality may differ.',
  static: 'Exploratory median of all visits. Wavelengths may differ and moving sources may remain.',
};

// In tracking mode the frame follows the object, so stars are what move.
const TRACK_HINTS = {
  play: 'The view follows the object: it stays centred while background stars stream past.',
  diff: 'Exploratory date minus median in the moving frame; wavelengths and quality may differ.',
  motion: 'Exploratory residuals in the moving frame; wavelengths and quality may differ.',
  static: 'Exploratory median in the object’s frame. Wavelengths may differ and background sources may remain.',
};

const state = {
  target: null,
  exposures: [],
  band: 2,
  size: 96,
  group: true,
  mode: 'play',
  frames: [],
  idx: 0,
  blinkA: 0,
  blinkB: -1,
  blinkAFrame: null,
  blinkBFrame: null,
  pickEpoch: 'A',
  playing: false,
  fps: 4,
  stretch: 'asinh',
  cmap: 'gray',
  contrast: 0.998,
  invert: false,
  crosshair: true,
  probe: null,
  lcView: 'time',
  colourFix: true,
  lcFix: null,
  spec: null,
  track: null,
  changes: null,
  tracks: null,
  markTrack: null,
  chFilter: 'unknown',
  mark: null,
  asteroids: false,
  astMag: 20,
  astList: null,
  lcPoints: null,
  mask: true,
  maxFrames: 80,
  limits: [0, 1],
  template: null,
  comparison: null,
  scanTemplate: null,
  scanCount: 0,
  scanTotal: 0,
  abort: null,
  blinkPhase: 0,
  window: null,
  qualityMask: false,
  context: 'none',
  restore: null,
};

try { state.maxFrames = Number(localStorage.getItem('maxFrames')) || 80; } catch {}

const canvas = $('canvas');
const ctx = canvas.getContext('2d');
let imageData = ctx.createImageData(state.size, state.size);
let archiveIndex = null;
let inspectedFrame = null;
const qualityCache = new WeakMap();
const validationResults = [];
let contextAbort = null, contextResult = null, contextKey = '', contextError = '';
const contextCache = new Map();

// ---------- helpers ----------

const allLoaded = () => state.frames.filter(f => f.status === 'ok');
const loaded = () => allLoaded().filter(f => inWavelengthWindow(f, state.window));

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  (document.fullscreenElement || document.body).appendChild(t);
  setTimeout(() => t.remove(), 6000);
}

function fmtDate(d) {
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function fmtDateTime(d) {
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function setLoading(text) {
  $('loading').hidden = !text;
  if (text) $('loadingText').textContent = text;
}

function writeHash() {
  if (!state.target) return;
  const p = new URLSearchParams();
  if (state.track) {
    p.set('track', state.track.query);
  } else {
    if (state.target.name) p.set('name', state.target.name);
    p.set('ra', state.target.ra);
    p.set('dec', state.target.dec);
  }
  p.set('band', state.band);
  p.set('fov', state.size);
  p.set('view', state.mode);
  const settings = encodeSettings({ ...state, epochA: state.restore?.epochA || frameKey(state.blinkAFrame),
    epochB: state.restore?.epochB || frameKey(state.blinkBFrame), epoch: state.restore?.epoch || frameKey(currentFrame()) });
  for (const [key, value] of settings) p.set(key, value);
  history.replaceState(null, '', '#' + p.toString());
}

// ---------- search & loading ----------

async function lookAt(query, opts = {}) {
  state.abort?.abort();
  const abort = new AbortController();
  state.abort = abort;
  $('intro').hidden = true;
  $('workspace').hidden = false;
  stop();
  state.target = null;
  state.exposures = [];
  if (!opts.shared) {
    state.window = null;
    state.restore = null;
    $('restoreNote').textContent = '';
    state.restoreFailed = state.restoredEpoch = false;
  }
  $('targetGuide').hidden = true;
  if (opts.size) state.size = opts.size;
  if (opts.mode) state.mode = opts.mode;
  renderSizes();
  renderModes();
  state.frames = [];
  state.template = null;
  drawAll();
  setLoading(opts.ra !== undefined ? 'Searching the SPHEREx archive…' : `Looking up “${query}”…`);

  if (opts.track) return trackObject(opts.track, opts, abort);
  state.track = null;
  renderModes();
  $('trackNote').hidden = true;
  if (opts.note && opts.ra !== undefined) {
    $('trackNote').hidden = false;
    $('trackNote').textContent = `${opts.note}. Fixed center; verify the position at each epoch.`;
  }
  $('changes').hidden = false;
  try {
    const target = opts.ra !== undefined
      ? { ra: opts.ra, dec: opts.dec, name: opts.name || null }
      : await resolve(query, abort.signal);
    state.target = target;
    renderTargetGuide();
    $('targetName').textContent = target.name || 'Custom position';
    $('targetCoords').textContent = `${formatRA(target.ra)}  ${formatDec(target.dec)}`;
    document.title = `${target.name || 'Sky position'} · SPHEREx Time-Lapse`;
    setLoading('Searching the SPHEREx archive…');

    const found = await findExposuresDetailed(target.ra, target.dec, abort.signal);
    if (abort.signal.aborted) return;
    archiveIndex ??= await loadIndex();
    state.exposures = found.exposures;
    state.coverageNote = found.failedTiles.length ? partialCoverageMessage(found.failedTiles.length, found.tiles) : '';
    if (state.coverageNote) toast(state.coverageNote);
    if (!state.exposures.length) {
      setLoading('');
      if (!state.coverageNote) toast(noCoverageMessage(indexSummary()));
      renderBands();
      return;
    }
    const counts = bandCounts();
    if (opts.band) state.band = opts.band;
    else if (!counts[state.band]) state.band = Number(Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0]);
    renderBands();
    loadBand();
  } catch (e) {
    if (e.name === 'AbortError') return;
    setLoading('');
    toast(e.message || String(e));
  }
}

async function trackObject(name, opts, abort) {
  try {
    setLoading(`Computing the orbit of “${name}”…`);
    const eph = await ephemeris(name, abort.signal);
    if (abort.signal.aborted) return;
    setLoading(`Searching SPHEREx images along the path of ${eph.name}…`);
    const at = mjd => positionAt(eph.points, mjd);
    const exps = await findAlongPath(eph.points, at, abort.signal, (d, n) => {
      $('loadingText').textContent = `Searching SPHEREx images along the path of ${eph.name}… ${Math.round((100 * d) / n)}%`;
    });
    if (abort.signal.aborted) return;
    state.track = { ...eph, query: name };
    renderModes();
    $('trackNote').hidden = false;
    $('trackNote').textContent = eph.precise
      ? 'Positions from JPL Horizons as seen from SPHEREx, including comets’ non-gravitational forces.'
      : 'Positions from IMCCE Miriade. Comet predictions can be off by a minute of arc or two; if the object isn’t at the centre, try a wider field of view.';
    if (!eph.precise && !opts.size && eph.kind === 'comet') { state.size = 160; renderSizes(); }
    state.exposures = exps;
    state.coverageNote = '';
    $('changes').hidden = true;
    $('targetName').textContent = eph.name;
    $('targetCoords').textContent = `Moving ${eph.kind || 'object'}`;
    document.title = `${eph.name} · SPHEREx Time-Lapse`;
    if (!exps.length) {
      setLoading('');
      toast(`SPHEREx hasn’t released any images of ${eph.name} yet.`);
      state.target = null;
      renderBands();
      return;
    }
    state.target = { name: eph.name, ra: exps[0].obj.ra, dec: exps[0].obj.dec, moving: true };
    renderTargetGuide();
    const counts = bandCounts();
    if (opts.band) state.band = opts.band;
    else if (!counts[state.band]) state.band = Number(Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0]);
    renderBands();
    loadBand();
  } catch (e) {
    if (e.name === 'AbortError') return;
    setLoading('');
    toast(e.message || String(e));
  }
}

// Sky centre of a frame: fixed for a place, the object's position when tracking.
function centreOf(frame) {
  return frame?.centre || [state.target.ra, state.target.dec];
}

function bandCounts() {
  const c = {};
  for (const e of state.exposures) c[e.detector] = (c[e.detector] || 0) + 1;
  return c;
}

function groupExposures(list) {
  if (!state.group) return list.map(e => ({ mjd: e.mjd, date: e.date, exposures: [e] }));
  const groups = [];
  for (const e of list) {
    const g = groups[groups.length - 1];
    if (g && e.mjd - g.exposures[0].mjd < 0.5) g.exposures.push(e);
    else groups.push({ mjd: e.mjd, date: e.date, exposures: [e] });
  }
  // Four exposures per visit is plenty; more just costs bandwidth.
  for (const g of groups) if (g.exposures.length > 4) g.exposures = g.exposures.filter((_, i, a) => i % Math.ceil(a.length / 4) === 0);
  return groups;
}

function sampleEvenly(arr, n) {
  if (arr.length <= n) return arr;
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.round((i * (arr.length - 1)) / (n - 1))]);
  return [...new Set(out)];
}

async function loadBand() {
  state.abort?.abort();
  const abort = new AbortController();
  state.abort = abort;
  stop();
  if (!state.restore) state.restoreFailed = state.restoredEpoch = false;
  const list = state.exposures.filter(e => e.detector === state.band);
  const groups = sampleEvenly(groupExposures(list), state.maxFrames);
  state.frames = groups.map(g => ({ ...g, status: 'pending' }));
  state.idx = 0;
  state.blinkA = 0;
  state.blinkB = -1;
  state.blinkAFrame = null;
  state.blinkBFrame = null;
  state.pickEpoch = 'A';
  state.template = null;
  state.comparison = null;
  state.scanTemplate = null;
  state.scanCount = 0;
  state.scanTotal = 0;
  state.probe = null;
  state.lcPoints = null;
  state.spec?.abort.abort();
  state.spec = null;
  state.changes = null;
  state.tracks = null;
  state.mark = null;
  state.markTrack = null;
  renderChanges();
  imageData = ctx.createImageData(state.size, state.size);
  canvas.width = canvas.height = state.size;
  ctx.clearRect(0, 0, state.size, state.size);
  $('filmstrip').innerHTML = '';
  writeHash();
  renderTimeline();
  drawOverlay();
  setLoading(`Downloading ${state.frames.length} visits in ${DETECTORS[state.band].name}…`);

  let done = 0;
  const size = state.size;
  const { ra, dec } = state.target;

  // Finish a frame once all its exposures are in.
  const finish = frame => {
    const records = frame.cuts.filter(Boolean);
    const cuts = records.map(c => c.data);
    if (!cuts.length) {
      frame.status = frame.failed ? 'error' : 'off';
    } else {
      const combined = cuts.length === 1 ? cuts[0] : nanMean(cuts);
      const { data, sigma } = backgroundSubtract(combined);
      frame.data = data;
      frame.sigma = sigma;
      if (frame.exposures[0].obj) {
        frame.centre = [frame.exposures[0].obj.ra, frame.exposures[0].obj.dec];
        frame.vmag = frame.exposures[0].obj.vmag;
      }
      // Keep the individual exposures so the change scan can reject
      // one-exposure glitches (cosmic rays, satellite glints).
      frame.parts = cuts.length > 1 ? cuts.map(c => backgroundSubtract(c).data) : null;
      frame.partTimes = frame.parts ? frame.exposures.filter((_, k) => frame.cuts[k]).map(e => e.mjd) : null;
      frame.analysisCuts = records;
      frame.analysisError = frame.failed || records.length !== frame.exposures.length ||
        records.some(c => !c.analysis || !c.wave);
      frame.qualityError = records.find(c => c.qualityError)?.qualityError;
      frame.waveError = records.find(c => c.waveError)?.waveError;
      const lams = records.map(c => c.lam).filter(v => v > 0);
      frame.lam = lams.length ? lams.reduce((a, b) => a + b, 0) / lams.length : null;
      frame.status = 'ok';
    }
    delete frame.cuts;
    done++;
    onFrameLoaded(done);
  };

  // One pool over all exposures (in frame order), so a frame's exposures
  // download in parallel instead of one after another.
  const queue = [];
  for (const frame of state.frames) {
    frame.cuts = [];
    frame.pending = frame.exposures.length;
    frame.exposures.forEach((e, k) => queue.push({ frame, e, k }));
  }
  const worker = async () => {
    while (queue.length && !abort.signal.aborted) {
      const { frame, e, k } = queue.shift();
      try {
        const c = await makeCutout(e, e.obj ? e.obj.ra : ra, e.obj ? e.obj.dec : dec, size, abort.signal, { mask: state.mask });
        c.exposureId = e.id;
        if (c.offImage) (frame.exposureIssues ??= []).push({ id: e.id, stage: 'cutout', message: 'Off image or insufficient displayed coverage' });
        frame.cuts[k] = c.offImage ? null : c;
        if (!c.offImage) {
          try {
            c.wave = await waveTable(e.url, abort.signal);
            c.lam = lookup(c.wave, c.pix[0], c.pix[1]).lam;
          } catch (err) {
            if (abort.signal.aborted) return;
            c.waveError = err.message || String(err);
            (frame.exposureIssues ??= []).push({ id: e.id, stage: 'wavelength', message: c.waveError });
            console.warn('wavelength unavailable', err);
          }
        }
      } catch (err) {
        if (abort.signal.aborted) return;
        console.warn('exposure failed', err);
        frame.failed = true;
        (frame.exposureIssues ??= []).push({ id: e.id, stage: 'cutout', message: err.message || String(err) });
      }
      if (--frame.pending === 0 && !abort.signal.aborted) finish(frame);
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  if (abort.signal.aborted) return;
  await new Promise(r => setTimeout(r, 80)); // let the last incremental refresh land
  recomputeLimits();
  drawAll(true);
  setLoading('');
  $('progressBar').style.width = '0';
  const n = loaded().length;
  restoreEpochs();
  renderWaveStatus();
  renderTargetGuide();
  if (!n) {
    toast(allLoaded().length ? 'No visits match the wavelength window. Widen it or choose All wavelengths.' : 'No usable cutouts loaded. Check the inspector, try a wider field or another detector.');
    if (!list.length) $('qualityNote').textContent = 'No indexed exposures in the requested detector. Choose a different detector; the saved detector was not substituted.';
    return;
  }
  if (state.restoreFailed || state.restoredEpoch) return;
  if (state.mode === 'play' && n > 1) play();
}

function nanMean(frames) {
  const out = new Float32Array(frames[0].length);
  for (let i = 0; i < out.length; i++) {
    let s = 0, m = 0;
    for (const f of frames) if (f[i] === f[i]) { s += f[i]; m++; }
    out[i] = m ? s / m : NaN;
  }
  return out;
}

let refreshQueued = false;
function onFrameLoaded(done) {
  $('progressBar').style.width = `${(100 * done) / state.frames.length}%`;
  const fr = loaded();
  if (fr.length) {
    setLoading('');
    state.blinkAFrame ??= fr[0];
    if (!state.blinkBFrame && fr.length > 1) state.blinkBFrame = fr.find(f => f !== state.blinkAFrame);
    state.blinkA = fr.indexOf(state.blinkAFrame);
    state.blinkB = state.blinkBFrame ? fr.indexOf(state.blinkBFrame) : -1;
  }
  if (refreshQueued) return;
  refreshQueued = true;
  // A timer rather than requestAnimationFrame, so loading still refreshes in a background tab.
  setTimeout(() => {
    refreshQueued = false;
    state.template = null;
    state.comparison = null;
    state.lcPoints = null;
    recomputeLimits();
    drawAll(false);
  }, 250);
}

// ---------- rendering ----------

function recomputeLimits() {
  const fr = loaded();
  if (!fr.length) return;
  state.limits = stretchLimits(fr.map(f => f.data), 0.25, state.contrast);
  // Lower limit a touch below the background so noise isn't clipped to black.
  const sig = median(fr.map(f => f.sigma));
  state.limits[0] = -1.5 * sig;
}

function getTemplate() {
  const fr = loaded();
  if (!state.template && fr.length) state.template = medianStack(fr.map(f => f.data));
  return state.template;
}

function currentFrame() {
  const fr = loaded();
  if (!fr.length) return null;
  if (state.mode === 'blink') {
    const i = state.blinkPhase ? state.blinkB : state.blinkA;
    return fr[Math.max(0, Math.min(fr.length - 1, i))];
  }
  state.idx = Math.max(0, Math.min(fr.length - 1, state.idx));
  return fr[state.idx];
}

function draw() {
  const fr = loaded();
  requestContext();
  renderWaveStatus();
  renderInspector();
  drawQualityOverlay();
  if (!fr.length) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    $('hudDate').textContent = '';
    $('hudFrame').textContent = '';
    $('qualityNote').textContent = allLoaded().length ? 'No loaded visits match this wavelength window. Widen the window or select All wavelengths.' : 'No loaded image is available yet.';
    drawLightcurve();
    return;
  }
  const f = currentFrame();
  if (state.mode === 'blink' && (!fr[state.blinkA] || !fr[state.blinkB])) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    $('hudDate').textContent = 'Select dates A and B';
    $('hudFrame').textContent = '';
    $('qualityNote').textContent = 'One or both selected visits are unavailable. Choose A and B again.';
    updateTimelineMarks();
    return;
  }
  const { stretch, cmap, invert, limits } = state;
  $('qualityNote').textContent = f.analysisError
    ? `Quality or wavelength metadata unavailable for this visit; browsing only. ${f.qualityError || f.waveError || 'An exposure failed or was off image.'} Retry loading before analysis.`
    : 'Analysis uses a stricter quality mask than the display; WCS-WAVE values are approximate.';
  switch (state.mode) {
    case 'compare': {
      const a = fr[state.blinkA], b = fr[state.blinkB];
      if (!state.comparison || state.comparison.a !== a || state.comparison.b !== b) {
        try {
          if (!a || !b || a === b) throw new Error('Choose two different visits for A and B.');
          if (state.track) throw new Error('A/B analysis is unavailable for moving-center tracking.');
          state.comparison = { a, b, result: prepareComparison([a, b], state.size) };
        } catch (err) { state.comparison = { a, b, error: err.message }; }
      }
      if (state.comparison.error) {
        imageData.data.fill(0);
        for (let i = 3; i < imageData.data.length; i += 4) imageData.data[i] = 255;
        $('qualityNote').textContent = state.comparison.error;
      } else {
        const result = state.comparison.result;
        paintDiff(imageData, subtract(result.frames[1].data, result.frames[0].data), 6 * median([a.sigma, b.sigma]));
        $('qualityNote').textContent = `Exploratory B − A · ${result.overlap} common pixels, ${result.background} source-free background pixels. Not calibrated.`;
      }
      break;
    }
    case 'diff': {
      const sig = median(fr.map(x => x.sigma));
      paintDiff(imageData, subtract(f.data, getTemplate()), 6 * sig);
      break;
    }
    case 'motion': {
      const t = getTemplate();
      paintMotion(imageData, fr.map(x => subtract(x.data, t)), fr.map(x => x.sigma));
      break;
    }
    case 'static': {
      // The stack is fainter than the brightest single visits: scale it on its own.
      const t = getTemplate();
      const own = stretchLimits([t], 0.25, state.contrast);
      const noise = backgroundSubtract(t).sigma;
      own[0] = -1.5 * noise;
      own[1] = Math.max(own[1], 15 * noise);
      paint(imageData, t, own, stretch, cmap, invert);
      break;
    }
    default:
      paint(imageData, f.data, limits, stretch, cmap, invert);
  }
  ctx.putImageData(imageData, 0, 0);

  const composite = state.mode === 'motion' || state.mode === 'static';
  if (composite) {
    $('hudDate').textContent = `${fmtDate(fr[0].date)} → ${fmtDate(fr[fr.length - 1].date)}`;
    $('hudFrame').textContent = `${fr.length} visits combined`;
  } else if (state.mode === 'compare') {
    $('hudDate').textContent = 'Exploratory B − A';
    $('hudFrame').textContent = '';
  } else {
    const label = state.mode === 'blink' ? (state.blinkPhase ? 'B  ' : 'A  ') : '';
    $('hudDate').textContent = label + fmtDateTime(f.date);
    $('hudFrame').textContent = `${fr.indexOf(f) + 1} / ${fr.length}${f.lam ? ` · λ ${f.lam.toFixed(2)} µm` : ''}${f.vmag ? ` · V ${f.vmag.toFixed(1)}` : ''}`;
  }
  canvas.setAttribute('aria-label', `SPHEREx ${DETECTORS[state.band].name} image of ${state.target?.name || 'this position'}, ${$('hudDate').textContent}, ${MODE_NAMES[state.mode]} view`);
  updateTimelineMarks();
  updateFilmstripMarks();
  drawLightcurve();
  requestAsteroids(composite ? null : f);
  drawOverlay();
}

// full=false (while loading) only paints thumbnails for newly arrived frames.
function drawAll(full = true) {
  draw();
  renderTimeline();
  renderFilmstrip(full);
}

function drawOverlay() {
  const svg = $('overlay');
  if (!loaded().length) { svg.replaceChildren(); return; }
  const n = state.size;
  const probe = state.probe
    ? `<circle cx="${((state.probe[0] + 0.5) / n) * 100}" cy="${((state.probe[1] + 0.5) / n) * 100}" r="${(3.5 / n) * 100}"
        fill="none" stroke="rgba(255,162,92,0.95)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`
    : '';
  const ast = asteroidMarks() + contextMarks() + trackOverlay() + (state.mark && currentFrame() === state.mark.frameRef
    ? `<circle cx="${((state.mark.x + 0.5) / n) * 100}" cy="${((state.mark.y + 0.5) / n) * 100}" r="${(5 / n) * 100}"
        fill="none" stroke="#ff6b6b" stroke-width="1.5" stroke-dasharray="3 2" vector-effect="non-scaling-stroke"/>`
    : '');
  if (!state.crosshair || !state.target) { svg.innerHTML = probe + ast; return; }
  const g = 3, l = 6;
  svg.innerHTML = ast + probe + `
    <g stroke="rgba(111,211,255,0.85)" stroke-width="0.35" vector-effect="non-scaling-stroke">
      <line x1="${50 - g - l}" y1="50" x2="${50 - g}" y2="50"/><line x1="${50 + g}" y1="50" x2="${50 + g + l}" y2="50"/>
      <line x1="50" y1="${50 - g - l}" x2="50" y2="${50 - g}"/><line x1="50" y1="${50 + g}" x2="50" y2="${50 + g + l}"/>
    </g>`;
}

// ---------- known asteroids ----------

let astFrame = null;
function requestAsteroids(frame) {
  if (!state.asteroids || !frame) {
    if (state.astList) { state.astList = null; drawOverlay(); }
    $('astNote').textContent = state.asteroids && !frame ? 'Asteroid labels show on single-date views.' : '';
    return;
  }
  if (astFrame === frame) return;
  astFrame = frame;
  state.astList = null;
  drawOverlay();
  $('astNote').textContent = 'Checking for known asteroids…';
  const radius = (state.size * PIXEL_ARCSEC) / 3600 * 0.72;
  const [cra, cdec] = centreOf(frame);
  knownObjects(frame.exposures[0].mjd, cra, cdec, radius)
    .then(list => {
      if (astFrame !== frame) return;
      state.astList = list;
      drawOverlay();
    })
    .catch(() => {
      if (astFrame === frame) $('astNote').textContent = 'Couldn’t reach the asteroid service (IMCCE SkyBoT).';
    });
}

function asteroidMarks() {
  if (!state.asteroids || !state.astList || !state.target) return '';
  const [cra, cdec] = centreOf(astFrame);
  const n = state.size, half = (n - 1) / 2, s = PIXEL_ARCSEC / 3600;
  const shown = [];
  for (const o of state.astList) {
    if (!(o.vmag <= state.astMag)) continue;
    const p = tanProject([cra * D2R, cdec * D2R], o.ra * D2R, o.dec * D2R);
    if (!p) continue;
    const i = half - p[0] / D2R / s, j = half - p[1] / D2R / s;
    if (i < 0 || j < 0 || i > n - 1 || j > n - 1) continue;
    shown.push({ ...o, x: ((i + 0.5) / n) * 100, y: ((j + 0.5) / n) * 100 });
  }
  $('astNote').textContent = shown.length
    ? `${shown.length} known asteroid${shown.length > 1 ? 's' : ''} brighter than V ${state.astMag} in view (positions: IMCCE SkyBoT).`
    : `No known asteroids brighter than V ${state.astMag} in view on this date.`;
  return shown.map(o => `
    <g class="ast">
      <circle cx="${o.x}" cy="${o.y}" r="2.2" fill="none" stroke="#77e0b5" stroke-width="1.2" vector-effect="non-scaling-stroke"/>
      <text x="${o.x + 2.8}" y="${o.y - 1.8}" fill="#77e0b5" font-size="2.6" font-family="Inter, sans-serif">${escapeHtml(o.name)} · V${o.vmag.toFixed(1)}</text>
    </g>`).join('');
}

function escapeHtml(t) {
  return String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function resetContext() {
  contextAbort?.abort();
  contextKey = '';
  contextResult = null;
  contextError = '';
  $('contextRetry').hidden = true;
}

function requestContext() {
  const frame = currentFrame();
  if (state.context === 'none' || !frame || !['play', 'blink'].includes(state.mode) || (state.track && state.playing)) {
    resetContext();
    $('contextNote').textContent = state.context === 'none' ? '' : !frame ? 'Catalog context needs a loaded visit.' :
      state.track && state.playing ? 'Pause the moving-object movie to load catalog context for this date.' :
      'Catalog context is available on single-date Time-lapse and Blink views.';
    $('contextDetails').textContent = $('contextNote').textContent;
    return;
  }
  const [ra, dec] = centreOf(frame), radius = state.size * PIXEL_ARCSEC / 3600 * 0.72;
  const key = `${state.context}:${ra.toFixed(7)}:${dec.toFixed(7)}:${radius}`;
  if (contextKey === key) return;
  resetContext();
  contextKey = key;
  if (contextCache.has(key)) { contextResult = contextCache.get(key); return; }
  const abort = contextAbort = new AbortController();
  $('contextNote').textContent = `Loading ${state.context === 'gaia' ? 'Gaia DR3' : 'AllWISE'} catalog context...`;
  fetchContext(ra, dec, radius + 0.05, { catalog: state.context, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]) })
    .then(result => {
      if (abort.signal.aborted || contextKey !== key) return;
      contextResult = result;
      if (contextCache.size >= 8) contextCache.delete(contextCache.keys().next().value);
      contextCache.set(key, result);
      drawOverlay();
    }).catch(error => {
      if (abort.signal.aborted || contextKey !== key) return;
      contextError = error.message || String(error);
      $('contextNote').textContent = contextError;
      $('contextDetails').textContent = contextError;
      $('contextRetry').hidden = false;
      drawOverlay();
    });
}

function contextMarks() {
  if (state.context === 'none' || !contextResult || !['play', 'blink'].includes(state.mode)) return '';
  const frame = currentFrame();
  if (!frame) return '';
  const projected = projectContextSources(contextResult, frame.date);
  const [ra, dec] = centreOf(frame), n = state.size, half = (n - 1) / 2, scale = PIXEL_ARCSEC / 3600;
  const shown = [];
  for (const source of projected.sources) {
    const p = tanProject([ra * D2R, dec * D2R], source.ra * D2R, source.dec * D2R);
    if (!p) continue;
    const x = half - p[0] / D2R / scale, y = half - p[1] / D2R / scale;
    if (x >= 0 && y >= 0 && x < n && y < n) shown.push({ ...source, x: (x + 0.5) * 100 / n, y: (y + 0.5) * 100 / n });
  }
  const caveat = state.context === 'gaia'
    ? 'Gaia DR3: J2016.0 positions, linearly propagated when proper motions are available; no parallax or radial-velocity correction. Missing-motion sources stay at the reference epoch.'
    : 'AllWISE: static catalog positions, not propagated; catalog image coadds have no single observation date. Markers are not WISE background imagery.';
  $('contextNote').textContent = `${shown.length} catalog markers in this field. ${caveat} A 0.05-degree query margin is not a completeness guarantee. ${projected.warnings.join(' ')}`;
  $('contextDetails').innerHTML = `<p>${escapeHtml(caveat)} Showing details for up to 20 visible sources; queries are capped and are not an exhaustive catalog search.</p><ul>${shown.slice(0, 20).map(s =>
    `<li>${escapeHtml(s.catalog)} ${escapeHtml(s.id)}: RA ${s.ra.toFixed(6)}, Dec ${s.dec.toFixed(6)} degrees; ${s.positionEpoch === null ? 'observation epoch unknown, static catalog position' : `position epoch ${s.positionEpoch.toFixed(3)}, ${s.positionProjected ? 'linear proper motion applied' : 'reference position; proper motion unavailable'}`}${s.w1mag !== null && s.w1mag !== undefined ? `; W1 ${s.w1mag.toFixed(2)} mag` : ''}${s.w2mag !== null && s.w2mag !== undefined ? `; W2 ${s.w2mag.toFixed(2)} mag` : ''}.</li>`).join('') || '<li>No returned source lies inside this image.</li>'}</ul>`;
  const color = state.context === 'gaia' ? '#b9d1ff' : '#ffce87';
  return shown.map(s => `<circle cx="${s.x}" cy="${s.y}" r="1.25" fill="none" stroke="${color}" stroke-width="1" vector-effect="non-scaling-stroke"/>`).join('');
}
$('contextCatalog').addEventListener('change', e => {
  stop();
  state.context = e.target.value;
  resetContext();
  draw();
  writeHash();
});
$('contextRetry').addEventListener('click', () => { resetContext(); draw(); });

$('asteroids').addEventListener('change', e => {
  state.asteroids = e.target.checked;
  astFrame = null;
  draw();
  drawOverlay();
});
$('astMag').addEventListener('change', e => { state.astMag = Number(e.target.value); drawOverlay(); });

// ---------- change scan ----------

const CH_LIMIT = 60;

async function scanChanges() {
  state.changes = null;
  state.tracks = null;
  state.scanTemplate = null;
  state.mark = null;
  state.markTrack = null;
  renderChanges();
  drawOverlay();
  if (state.track) {
    $('chSummary').textContent = 'Change scans are unavailable for moving-center tracking. Choose a fixed sky position.';
    toast($('chSummary').textContent);
    return;
  }
  const all = loaded();
  if (all.length < 3) { toast('Need at least three visits to find changes.'); return; }
  if (state.frames.some(f => f.status === 'pending')) { toast('Wait for all visits to finish loading before scanning.'); return; }
  const fr = selectCompatibleFrames(all);
  if (fr.length < 3) {
    const message = `Only ${fr.length} of ${all.length} visits have mutually compatible target wavelengths and available quality. Try disabling same-day grouping or selecting another detector.`;
    $('chSummary').textContent = message;
    toast(message);
    return;
  }
  let prepared;
  try { prepared = prepareComparison(fr, state.size); }
  catch (err) { $('chSummary').textContent = err.message; toast(err.message); return; }
  const btn = $('scanBtn');
  const load = state.abort;
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  await new Promise(r => setTimeout(r, 20)); // let the button repaint
  if (state.abort !== load) { btn.disabled = false; btn.textContent = 'Scan for changes'; return; }
  const n = state.size;
  const af = prepared.frames;
  const found = findChanges(af, prepared.template, n).slice(0, 300);
  for (const c of found) { c.frameRef = fr[c.frame]; c.analysisFrame = af[c.frame]; }
  state.scanTemplate = prepared.template;
  state.scanCount = fr.length;
  state.scanTotal = all.length;
  state.changes = found;
  // Link detections into moving-object tracklets: slow movers across visits,
  // fast movers across the exposures of a single visit.
  const tmpl = prepared.template;
  state.tracks = [
    ...linkAcrossVisits(found, af).map(t => ({ ...t, frames: t.changes.map(c => c.frameRef) })),
    ...linkWithinVisits(af, tmpl, n).map(t => ({ ...t, frames: [fr[t.frame]], analysisFrame: af[t.frame] })),
  ];
  state.chFilter = state.tracks.length ? 'moving' : 'unknown';
  renderChanges();

  // Identify "new" sources against catalogued asteroids, one visit at a time.
  const byFrame = new Map();
  const inTrack = new Set(state.tracks.flatMap(t => t.changes || []));
  for (const c of found) if ((c.kind === 'new' || inTrack.has(c)) && !c.glitch) (byFrame.get(c.frameRef) || byFrame.set(c.frameRef, []).get(c.frameRef)).push(c);
  let k = 0;
  const radius = (n * PIXEL_ARCSEC) / 3600 * 0.72, half = (n - 1) / 2, px = PIXEL_ARCSEC / 3600;
  const queue = [...byFrame];
  const check = async () => {
    while (queue.length) {
      const [frame, cands] = queue.shift();
      try {
        const objs = await knownObjects(frame.exposures[0].mjd, state.target.ra, state.target.dec, radius);
        for (const c of cands) {
          let best = null, bd = Infinity;
          for (const o of objs) {
            const p = tanProject([state.target.ra * D2R, state.target.dec * D2R], o.ra * D2R, o.dec * D2R);
            if (!p) continue;
            const d = Math.hypot(half - p[0] / D2R / px - c.x, half - p[1] / D2R / px - c.y);
            // ~21″ normally; bright objects saturate and their detected peak wanders.
            const tol = o.vmag < 12 ? 8 : 3.5;
            if (d < tol && d < bd) { bd = d; best = o; }
          }
          c.known = best;
        }
      } catch {
        for (const c of cands) c.known = undefined;
      }
      btn.textContent = `Checking asteroids ${++k}/${byFrame.size}`;
      queueRenderChanges();
    }
  };
  // A few at a time: SkyBoT is a shared public service.
  await Promise.all([check(), check(), check()]);
  if (state.abort !== load) { btn.textContent = 'Scan for changes'; btn.disabled = false; return; }
  btn.textContent = 'Scan again';
  btn.disabled = false;
  renderChanges();
}

let renderPending = false;
function queueRenderChanges() {
  if (renderPending) return;
  renderPending = true;
  setTimeout(() => { renderPending = false; renderChanges(); }, 150);
}

function trackName(t) {
  const names = (t.changes || []).map(c => c.known?.name).filter(Boolean);
  if (!names.length) return null;
  const top = names.sort((a, b) => names.filter(x => x === b).length - names.filter(x => x === a).length)[0];
  return names.filter(x => x === top).length * 2 >= names.length ? top : null;
}

function compass(vx, vy) {
  // pixel x grows westward and y southward (north up, east left)
  const ang = (Math.atan2(-vx, -vy) * 180) / Math.PI; // 0 = north, 90 = east
  return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(((ang + 360) % 360) / 45) % 8];
}

// ---------- reporting ----------

const ISSUES = 'https://github.com/ShivenKhurana1/spherex-timelapse/issues/new';

function pixSky(x, y) {
  const n = state.size, s = (PIXEL_ARCSEC / 3600) * D2R, half = (n - 1) / 2;
  return tanDeproject([state.target.ra * D2R, state.target.dec * D2R], -(x - half) * s, (half - y) * s);
}

const skyLine = (ra, dec) => `${formatRA(ra)} ${formatDec(dec)} (RA ${ra.toFixed(5)}°, Dec ${dec.toFixed(5)}°)`;

// A prefilled GitHub issue, so anyone can flag a candidate for others to check.
function reportLink(title, lines) {
  const body = [
    ...lines,
    `Detector: ${DETECTORS[state.band].name}`,
    `View: ${location.href}`,
    '',
    '_What makes you think this is real? Anything else you noticed?_',
  ].join('\n');
  const a = document.createElement('a');
  a.className = 'ch-report';
  a.href = `${ISSUES}?${new URLSearchParams({ template: 'candidate.md', title, body, labels: 'candidate' })}`;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = 'Report';
  a.title = 'Open a public GitHub issue about this candidate';
  return a;
}

function changeFilter(c) {
  switch (state.chFilter) {
    case 'unknown': return c.kind === 'new' && !c.known && !c.glitch;
    case 'glitch': return c.glitch;
    case 'known': return !!c.known;
    case 'brightened': return c.kind === 'brightened' && !c.glitch;
    default: return true;
  }
}

function renderChanges() {
  const list = $('chList');
  list.innerHTML = '';
  $('chFilters').hidden = !state.changes;
  $('candidateCsv').disabled = !state.changes;
  if (!state.changes) {
    $('scanBtn').textContent = 'Scan for changes';
    $('chSummary').textContent = 'Exploratory scan requires compatible wavelengths and common quality-valid, source-free support.';
    return;
  }
  const all = state.changes;
  const tracks = state.tracks || [];
  const nNew = all.filter(c => c.kind === 'new' && !c.known && !c.glitch).length;
  const nGlitch = all.filter(c => c.glitch).length;
  const nKnown = all.filter(c => c.known).length;
  const nBright = all.filter(c => c.kind === 'brightened' && !c.glitch).length;
  $('chSummary').textContent = (tracks.length ? `${tracks.length} possible moving object${tracks.length > 1 ? 's' : ''} linked across detections. ` : '') + (all.length
    ? `${all.length} candidate${all.length > 1 ? 's' : ''}: ${nNew} unidentified, ${nKnown} known asteroid${nKnown === 1 ? '' : 's'}, ${nBright} brightened, ${nGlitch} single-exposure glitch${nGlitch === 1 ? '' : 'es'}.`
    : 'No candidates found.') + ` Scanned ${state.scanCount} of ${state.scanTotal} loaded visits; others excluded for quality or target compatibility. Exploratory only; not calibrated significance.`;
  for (const b of $('chFilters').children) b.setAttribute('aria-pressed', String(b.dataset.f === state.chFilter));

  if (state.chFilter === 'moving') { renderTracks(list, tracks); return; }
  const shown = all.filter(changeFilter).slice(0, CH_LIMIT);
  if (!shown.length) {
    list.innerHTML = `<li class="ch-empty">${all.length ? 'None in this group.' : 'Try a larger field of view or another band.'}</li>`;
    return;
  }
  const n = state.size, t = state.scanTemplate;
  const sig = median(loaded().map(f => f.sigma));
  const inTrack = new Set(tracks.flatMap(tr => tr.changes || []));
  for (const c of shown) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'ch-item' + (state.mark === c ? ' active' : '');
    const crops = document.createElement('div');
    crops.className = 'ch-crops';
    const f = c.frameRef;
    const cutF = crop(c.analysisFrame.data, n, c.x, c.y), cutT = crop(t, n, c.x, c.y);
    const diff = cutF.map((v, i) => v - cutT[i]);
    const cw = Math.round(Math.sqrt(cutF.length));
    for (const [data, isDiff] of [[cutF, false], [cutT, false], [diff, true]]) {
      const cv = document.createElement('canvas');
      cv.width = cv.height = cw;
      const id = new ImageData(cw, cw);
      if (isDiff) paintDiff(id, data, 6 * sig); else paint(id, data, state.limits, state.stretch, 'gray', false);
      cv.getContext('2d').putImageData(id, 0, 0);
      crops.appendChild(cv);
    }
    const txt = document.createElement('div');
    txt.className = 'ch-text';
    const [ra, dec] = pixSky(c.x, c.y);
    const badge = c.known
      ? `<span class="ch-badge known">Known asteroid</span>`
      : c.glitch ? `<span class="ch-badge glitch">Glitch</span>`
      : `<span class="ch-badge ${c.kind}">${c.kind === 'new' ? 'New source' : 'Brightened'}</span>`;
    const seen = c.parts ? ` · in ${c.seenIn} of ${c.parts} exposures` : ' · single exposure, could be a glitch';
    const who = c.known
      ? `${escapeHtml(c.known.name)} · V ${c.known.vmag.toFixed(1)}`
      : c.glitch ? 'Not in the other exposures of this visit'
      : c.kind === 'new'
        ? (!('known' in c) ? 'Checking asteroid catalogue…' : c.known === undefined ? 'Asteroid check failed' : 'Not a catalogued asteroid')
        : `${Math.round((100 * c.flux) / Math.max(c.base, 1e-9))}% brighter than usual`;
    txt.innerHTML = `${badge}<strong>${fmtDateTime(f.date)}</strong>
      <small>${who}${seen} · ${fmtSnr(c.snr)} · ${formatRA(ra)} ${formatDec(dec)}</small>`;
    b.append(crops, txt);
    b.onclick = () => showChange(c);
    li.appendChild(b);
    // Offer a report once the asteroid check has cleared it, or for brightenings.
    // Detections that belong to a moving object are reported with it instead.
    if (!c.glitch && c.seenIn >= 2 && !inTrack.has(c) && (c.kind === 'brightened' || c.known === null)) {
      const what = c.kind === 'new' ? 'Uncatalogued source' : 'Brightened source';
      li.appendChild(reportLink(`${what} at ${formatRA(ra)} ${formatDec(dec)} on ${fmtDate(f.date)}`, [
        `**${what}** found by the change scan.`,
        '',
        `Position: ${skyLine(ra, dec)}`,
        `Date: ${fmtDateTime(f.date)} (MJD ${f.mjd.toFixed(5)})`,
        `Exploratory filter score (not calibrated significance): ${fmtSnr(c.snr)}${c.parts ? `, seen in ${c.seenIn} of ${c.parts} exposures` : ''}`,
        'WCS-WAVE matching and quality screening are approximate; independent verification is required.',
        ...(c.kind === 'brightened' ? [`Brightening: ${Math.round((100 * c.flux) / Math.max(c.base, 1e-9))}% above its usual level`] : []),
        `Image: ${f.exposures[0].url}`,
      ]));
    }
    list.appendChild(li);
  }
}

function renderTracks(list, tracks) {
  if (!tracks.length) {
    list.innerHTML = '<li class="ch-empty">No detections line up into a moving object here.</li>';
    return;
  }
  const n = state.size;
  const sig = median(loaded().map(f => f.sigma));
  const t = state.scanTemplate;
  for (const tr of tracks) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'ch-item' + (state.markTrack === tr ? ' active' : '');
    const crops = document.createElement('div');
    crops.className = 'ch-crops';
    const pick = [0, Math.floor(tr.pts.length / 2), tr.pts.length - 1];
    for (const k of [...new Set(pick)]) {
      const p = tr.pts[k];
      const x = Math.round(p.x), y = Math.round(p.y);
      const img = tr.kind === 'fast' ? tr.analysisFrame.parts[p.group] : p.change.analysisFrame.data;
      const cut = crop(img, n, x, y), base = crop(t, n, x, y);
      const cw = Math.round(Math.sqrt(cut.length));
      const cv = document.createElement('canvas');
      cv.width = cv.height = cw;
      const id = new ImageData(cw, cw);
      paintDiff(id, cut.map((v, i) => v - base[i]), 6 * sig);
      cv.getContext('2d').putImageData(id, 0, 0);
      crops.appendChild(cv);
    }
    const txt = document.createElement('div');
    txt.className = 'ch-text';
    const days = tr.pts.at(-1).t - tr.pts[0].t;
    const pxPerDay = Math.hypot(tr.fit.vx, tr.fit.vy);
    const name = trackName(tr);
    const rate = tr.kind === 'fast'
      ? `${((pxPerDay * PIXEL_ARCSEC) / 1440).toFixed(1)}″/min`
      : `${(pxPerDay * PIXEL_ARCSEC).toFixed(1)}″/day`;
    const span = tr.kind === 'fast'
      ? `in ${tr.pts.length} exposures over ${Math.round(days * 1440)} min`
      : `on ${tr.pts.length} visits over ${days.toFixed(1)} days`;
    txt.innerHTML = `<span class="ch-badge ${name ? 'known' : 'new'}">${tr.kind === 'fast' ? 'Fast mover' : 'Slow mover'}</span><strong>${name ? escapeHtml(name) : 'Unidentified moving object'}</strong>
      <small>Seen ${span} · ${rate} toward the ${compass(tr.fit.vx, tr.fit.vy)} · path fits to ${(tr.fit.rms * PIXEL_ARCSEC).toFixed(1)}″ · starting ${fmtDate(tr.frames[0].date)}</small>`;
    b.append(crops, txt);
    b.onclick = () => showTrack(tr);
    li.appendChild(b);
    if (!name) {
      const a0 = tr.pts[0], a1 = tr.pts.at(-1);
      const [ra0, dec0] = pixSky(a0.x, a0.y), [ra1, dec1] = pixSky(a1.x, a1.y);
      li.appendChild(reportLink(`Possible moving object near ${formatRA(ra0)} ${formatDec(dec0)} (${fmtDate(tr.frames[0].date)})`, [
        `**Unidentified ${tr.kind === 'fast' ? 'fast' : 'slow'} mover** linked by the change scan.`,
        '',
        `Seen ${span}, moving ${rate} toward the ${compass(tr.fit.vx, tr.fit.vy)}; path fits to ${(tr.fit.rms * PIXEL_ARCSEC).toFixed(1)}″`,
        `First: ${skyLine(ra0, dec0)} at MJD ${(tr.pts[0].t).toFixed(5)}`,
        `Last: ${skyLine(ra1, dec1)} at MJD ${(tr.pts.at(-1).t).toFixed(5)}`,
        `Images: ${[...new Set(tr.frames.map(f => f.exposures[0].url))].slice(0, 8).join(' ')}`,
      ]));
    }
    list.appendChild(li);
  }
}

function showTrack(tr) {
  stop();
  if (state.mode !== 'diff') setMode('diff');
  state.idx = loaded().indexOf(tr.frames[0]);
  state.mark = null;
  state.markTrack = tr;
  draw();
  drawOverlay();
  renderChanges();
  $('viewer').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function trackOverlay() {
  const tr = state.markTrack;
  if (!tr) return '';
  const n = state.size;
  const cur = currentFrame();
  if (tr.kind === 'fast' && cur !== tr.frames[0]) return '';
  const pos = p => [((p.x + 0.5) / n) * 100, ((p.y + 0.5) / n) * 100];
  const path = tr.pts.map(p => pos(p).map(v => v.toFixed(2)).join(',')).join(' ');
  const dots = tr.pts.map((p, k) => {
    const [x, y] = pos(p);
    const here = tr.kind === 'slow' && tr.frames[k] === cur;
    return here
      ? `<circle cx="${x}" cy="${y}" r="${(4 / n) * 100}" fill="none" stroke="#ff6b6b" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`
      : `<circle cx="${x}" cy="${y}" r="${(0.7 / n) * 100}" fill="#ff6b6b"/>`;
  }).join('');
  return `<polyline points="${path}" fill="none" stroke="#ff6b6b" stroke-width="1" stroke-dasharray="3 2" vector-effect="non-scaling-stroke" opacity="0.8"/>${dots}`;
}

function fmtSnr(v) {
  return v >= 1000 ? `${Math.round(v / 1000)}k× residual noise` : `${Math.round(v)}× residual noise`;
}

function showChange(c) {
  stop();
  if (state.mode !== 'diff') setMode('diff');
  state.idx = loaded().indexOf(c.frameRef);
  state.mark = c;
  state.markTrack = null;
  draw();
  drawOverlay();
  renderChanges();
  $('viewer').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

$('scanBtn').addEventListener('click', scanChanges);
$('chFilters').addEventListener('click', e => {
  const f = e.target.closest('button')?.dataset.f;
  if (!f) return;
  state.chFilter = f;
  renderChanges();
});

// ---------- light curve ----------

function lightcurvePoints() {
  if (!state.probe) return [];
  if (!state.lcPoints) {
    const n = state.size;
    state.lcPoints = [];
    state.lcSaturated = 0;
    state.lcUnavailable = 0;
    loaded().forEach((f, i) => {
      if (f.analysisError) { state.lcUnavailable++; return; }
      const strict = Float32Array.from({ length: n * n }, (_, k) => {
        const values = f.analysisCuts.map(c => c.analysis[k]);
        return values.every(Number.isFinite) ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
      });
      const p = photometry(strict, n, state.probe[0], state.probe[1], f.sigma);
      if (!inWavelengthWindow(f, state.window, state.probe, n)) { state.lcUnavailable++; return; }
      const spectra = f.analysisCuts.map(c => spectrumAtCut(c, state.probe, n));
      if (spectra.some(v => !v)) { state.lcUnavailable++; return; }
      const lam = spectra.reduce((sum, v) => sum + v.lam, 0) / spectra.length;
      if (p?.saturated) state.lcSaturated++;
      else if (p) state.lcPoints.push({ ...p, mjd: f.mjd, date: f.date, i, lam });
    });
    // Rescale every visit to one wavelength so filter-colour differences don't look like variability.
    state.lcFix = state.colourFix && !state.window ? colourCorrect(state.lcPoints) : null;
    if (state.lcFix) state.lcPoints = state.lcFix.points;
  }
  return state.lcPoints;
}

function drawLightcurve() {
  $('lc').hidden = !state.probe;
  $('lcInvite').hidden = !!state.probe || !loaded().length;
  if (!state.probe) return;
  for (const b of $('lcTabs').children) b.setAttribute('aria-selected', String(b.dataset.v === state.lcView));
  $('lcTitle').textContent = state.lcView === 'spectrum' ? 'Spectrum' : 'Brightness over time';
  if (state.lcView === 'spectrum') { $('colourRow').hidden = true; drawSpectrum(); return; }
  $('colourRow').hidden = !!state.window;
  lightcurvePoints();
  $('lcCaveat').textContent = state.lcFix
    ? `Exploratory, not calibrated: adjusted to ${state.lcFix.lam0.toFixed(2)} µm using a smooth colour fit; this does not establish matched-band variability.`
    : state.window ? `Wavelength-filtered at the target and selected point (${state.window.min}-${state.window.max} micrometres). Still exploratory: bandwidth, PSF and registration can differ. At least two measurements are needed to compare dates.`
    : 'Exploratory, not calibrated: visits can have different wavelengths, PSFs and registration.';
  const composite = state.mode === 'motion' || state.mode === 'static';
  const cur = composite ? -1 : loaded().indexOf(currentFrame());
  const pts = lightcurvePoints();
  renderChart($('lcSvg'), pts, cur, fmtDate);
  const sat = state.lcSaturated;
  $('lcNote').textContent = !pts.length && sat
    ? 'Pixels near the source were unavailable or flagged; brightness cannot be measured.'
    : !pts.length ? 'Not enough clean data around this point to measure it.'
    : `${sat ? `${sat} visit(s) skipped: source pixels unavailable. ` : ''}${state.lcUnavailable ? `${state.lcUnavailable} visit(s) skipped: quality or wavelength unavailable.` : ''}`;
}

// ---------- spectrum ----------

const SPEC_PER_BAND = 40;
const SPEC_SIZE = 21; // small cutouts: just enough for the aperture and background ring

function drawSpectrum() {
  const sp = state.spec;
  const pts = sp?.points || [];
  renderSpectrum($('lcSvg'), pts);
  $('lcCaveat').textContent = 'Exploratory measurements, not calibrated photometry. Each dot is one exposure; WCS-WAVE wavelengths are approximate.';
  $('lcNote').textContent = !sp ? ''
    : sp.error ? sp.error
    : sp.loading ? `Measuring… ${sp.done} of ${sp.total} exposures`
    : pts.length ? `${pts.length} measurements across ${new Set(pts.map(p => p.det)).size} bands${sp.skipped ? ` · ${sp.skipped} skipped (saturated, flagged or off the detector)` : ''}.`
    : 'No clean measurements: the star may be too bright (saturated) or too faint.';
}

function probeSky() {
  const n = state.size, s = (PIXEL_ARCSEC / 3600) * D2R, half = (n - 1) / 2;
  const [pra, pdec] = centreOf(currentFrame());
  return tanDeproject([pra * D2R, pdec * D2R], -(state.probe[0] - half) * s, (half - state.probe[1]) * s);
}

async function measureSpectrum() {
  state.spec?.abort.abort();
  const abort = new AbortController();
  const half = (state.size - 1) / 2;
  const onObject = state.track && Math.hypot(state.probe[0] - half, state.probe[1] - half) <= 2;
  const sp = state.spec = { abort, points: [], loading: true, done: 0, total: 0, skipped: 0, probe: state.probe };
  if (state.track && !onObject) {
    sp.loading = false;
    sp.error = 'In tracking mode, a spectrum can be measured for the tracked object (click the centre).';
    drawLightcurve();
    return;
  }
  const [ra, dec] = probeSky();
  // Evenly sample each band so a deep field doesn't mean thousands of requests.
  const byDet = {};
  for (const e of state.exposures) (byDet[e.detector] ??= []).push(e);
  const queue = Object.values(byDet).flatMap(list => sampleEvenly(list, SPEC_PER_BAND));
  sp.total = queue.length;
  drawLightcurve();
  let pending = false;
  const refresh = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; if (state.spec === sp && state.lcView === 'spectrum') drawLightcurve(); }, 250);
  };
  const c0 = (SPEC_SIZE - 1) / 2;
  const worker = async () => {
    while (queue.length && !abort.signal.aborted) {
      const e = queue.shift();
      try {
        const [r, d] = onObject ? [e.obj.ra, e.obj.dec] : [ra, dec];
        const c = await makeCutout(e, r, d, SPEC_SIZE, abort.signal, { mask: state.mask });
        if (c.offImage || !c.analysis) { sp.skipped++; continue; }
        const { data, sigma } = backgroundSubtract(c.analysis);
        const p = photometry(data, SPEC_SIZE, c0, c0, sigma);
        if (!p || p.saturated) { sp.skipped++; continue; }
        const { lam } = await wavelengthAt(e.url, c.pix[0], c.pix[1], abort.signal);
        sp.points.push({ ...p, lam, det: e.detector, date: e.date });
      } catch {
        if (abort.signal.aborted) return;
        sp.skipped++;
      } finally {
        sp.done++;
        refresh();
      }
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  if (abort.signal.aborted) return;
  sp.points.sort((a, b) => a.lam - b.lam);
  sp.loading = false;
  if (state.spec === sp) drawLightcurve();
}

function setLcView(v) {
  state.lcView = v;
  $('lcTip').hidden = true;
  if (v === 'spectrum' && (!state.spec || state.spec.probe !== state.probe)) measureSpectrum();
  drawLightcurve();
}

$('colourFix').addEventListener('change', e => {
  state.colourFix = e.target.checked;
  state.lcPoints = null;
  drawLightcurve();
});

$('lcTabs').addEventListener('click', e => {
  const v = e.target.closest('button')?.dataset.v;
  if (v) setLcView(v);
});

function setProbe(i, j, snap = true) {
  const n = state.size;
  const t = getTemplate();
  state.probe = snap && t ? snapToPeak(t, n, i, j) : [i, j];
  state.lcPoints = null;
  state.spec?.abort.abort();
  state.spec = null;
  const s = (PIXEL_ARCSEC / 3600) * D2R, half = (n - 1) / 2;
  const [pra, pdec] = centreOf(currentFrame());
  const [ra, dec] = tanDeproject([pra * D2R, pdec * D2R], -(state.probe[0] - half) * s, (half - state.probe[1]) * s);
  $('lcWhere').textContent = state.track
    ? `${state.probe[0] === Math.round(half) && state.probe[1] === Math.round(half) ? state.track.name : 'Point'} in the moving frame · ${DETECTORS[state.band].name} · aperture 15″ radius`
    : `${formatRA(ra)} ${formatDec(dec)} · ${DETECTORS[state.band].name} · aperture 15″ radius`;
  drawOverlay();
  if (state.lcView === 'spectrum') measureSpectrum();
  drawLightcurve();
}

$('imageSurface').addEventListener('click', e => {
  if (!loaded().length) return;
  const r = canvas.getBoundingClientRect(), n = state.size;
  const i = Math.floor(((e.clientX - r.left) / r.width) * n);
  const j = Math.floor(((e.clientY - r.top) / r.height) * n);
  if (i >= 0 && j >= 0 && i < n && j < n) setProbe(i, j);
});

$('lcClear').addEventListener('click', () => {
  state.probe = null;
  state.lcPoints = null;
  state.spec?.abort.abort();
  state.spec = null;
  drawOverlay();
  drawLightcurve();
});

$('lcCsv').addEventListener('click', () => {
  const csv = state.lcView === 'spectrum' ? spectrumCSV(state.spec?.points || []) : toCSV(lightcurvePoints());
  download(new Blob([csv], { type: 'text/csv' }), 'csv');
});

$('lcSvg').addEventListener('mousemove', e => {
  const g = e.target.closest('.lc-pt');
  const tip = $('lcTip');
  if (!g) { tip.hidden = true; return; }
  const spec = state.lcView === 'spectrum';
  const p = (spec ? state.spec?.points || [] : lightcurvePoints())[Number(g.dataset.k)];
  if (!p) return;
  const dot = g.querySelector('.lc-dot').getBoundingClientRect();
  const wrap = $('lcSvg').parentElement.getBoundingClientRect();
  tip.innerHTML = spec
    ? `λ ${p.lam.toFixed(3)} µm <span>· ${DETECTORS[p.det].name} · ${fmtDate(p.date)}</span><br>${p.flux.toFixed(2)} <span>± ${p.err.toFixed(2)} mJy</span>`
    : `${fmtDateTime(p.date)}${p.lam ? ` <span>· λ ${p.lam.toFixed(3)} µm</span>` : ''}<br>${p.flux.toFixed(2)} <span>± ${p.err.toFixed(2)} mJy${p.rawFlux !== undefined ? ` (measured ${p.rawFlux.toFixed(2)})` : ''}</span>`;
  tip.style.left = `${dot.left + dot.width / 2 - wrap.left}px`;
  tip.style.top = `${dot.top - wrap.top}px`;
  tip.hidden = false;
});
$('lcSvg').addEventListener('mouseleave', () => { $('lcTip').hidden = true; });
$('lcSvg').addEventListener('click', e => {
  const g = e.target.closest('.lc-pt');
  if (!g || state.lcView === 'spectrum') return;
  stop();
  if (state.mode === 'motion' || state.mode === 'static') setMode('play');
  if (state.mode === 'blink') setMode('play');
  state.idx = lightcurvePoints()[Number(g.dataset.k)].i;
  draw();
});

// ---------- timeline & filmstrip ----------

function timeRange() {
  const all = state.frames;
  if (!all.length) return [0, 1];
  const t0 = all[0].mjd, t1 = all[all.length - 1].mjd;
  return t1 > t0 ? [t0, t1] : [t0 - 1, t1 + 1];
}

function renderTimeline() {
  const ticks = $('ticks'), axis = $('axis');
  ticks.innerHTML = '';
  axis.innerHTML = '';
  const [t0, t1] = timeRange();
  const fr = loaded();
  for (const f of state.frames) {
    if (f.status === 'off' || f.status === 'error' || (f.status === 'ok' && !fr.includes(f))) continue;
    const d = document.createElement('div');
    d.className = 'tick' + (f.status === 'ok' ? ' loaded' : '');
    d.style.left = `${(100 * (f.mjd - t0)) / (t1 - t0)}%`;
    d.dataset.i = fr.indexOf(f);
    d.title = fmtDateTime(f.date);
    ticks.appendChild(d);
  }
  // Month labels
  if (state.frames.length) {
    const start = new Date((t0 - 40587) * 864e5), end = new Date((t1 - 40587) * 864e5);
    const months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth();
    const step = months > 18 ? 6 : months > 8 ? 3 : 1;
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    for (; d <= end; d.setUTCMonth(d.getUTCMonth() + step)) {
      const mjd = d.getTime() / 864e5 + 40587;
      const s = document.createElement('span');
      s.style.left = `${(100 * (mjd - t0)) / (t1 - t0)}%`;
      s.textContent = d.toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' });
      axis.appendChild(s);
    }
  }
  updateTimelineMarks();
}

function updateTimelineMarks() {
  const blink = state.mode === 'blink' || state.mode === 'compare';
  const composite = state.mode === 'motion' || state.mode === 'static';
  for (const t of $('ticks').children) {
    const i = Number(t.dataset.i);
    t.classList.toggle('current', i >= 0 && !blink && !composite && i === state.idx);
    t.classList.toggle('blink-a', i >= 0 && blink && i === state.blinkA);
    t.classList.toggle('blink-b', i >= 0 && blink && i === state.blinkB);
  }
  const fr = loaded();
  $('blinkPick').hidden = !blink || fr.length < 2;
  if (blink && fr.length >= 2) {
    $('blinkA').textContent = fr[state.blinkA] ? fmtDate(fr[state.blinkA].date) : 'Unavailable';
    $('blinkB').textContent = fr[state.blinkB] ? fmtDate(fr[state.blinkB].date) : 'Unavailable';
    for (const b of $('blinkPick').querySelectorAll('[data-pick]')) {
      b.setAttribute('aria-pressed', String(b.dataset.pick === state.pickEpoch));
    }
  }
}

const thumbs = new WeakMap(); // frame -> thumbnail button

function renderFilmstrip(full = true) {
  const strip = $('filmstrip');
  const fr = loaded();
  const n = state.size;
  const id = new ImageData(n, n);
  const paintThumb = (f, c) => {
    paint(id, f.data, state.limits, state.stretch, state.cmap, state.invert);
    c.getContext('2d').putImageData(id, 0, 0);
  };
  const keep = new Set();
  fr.forEach((f, i) => {
    let b = thumbs.get(f);
    if (!b || b.firstChild.width !== n) {
      b = document.createElement('button');
      b.className = 'thumb';
      const c = document.createElement('canvas');
      c.width = c.height = n;
      const s = document.createElement('small');
      s.textContent = fmtDate(f.date);
      b.append(c, s);
      thumbs.set(f, b);
      paintThumb(f, c);
    } else if (full) {
      paintThumb(f, b.firstChild);
    }
    b.dataset.i = i;
    keep.add(b);
    strip.appendChild(b); // re-appending keeps date order as frames arrive out of order
  });
  for (const b of [...strip.children]) if (!keep.has(b)) b.remove();
  updateFilmstripMarks();
}

function updateFilmstripMarks() {
  const fr = loaded();
  const cur = fr.indexOf(currentFrame());
  const picking = state.mode === 'blink' || state.mode === 'compare';
  for (const b of $('filmstrip').children) {
    const i = Number(b.dataset.i);
    const on = i === cur;
    if (on && !b.classList.contains('current') && state.playing) {
      // Scroll only the strip sideways; scrollIntoView would also jump the page.
      const strip = $('filmstrip');
      const left = b.offsetLeft - strip.offsetLeft;
      if (left < strip.scrollLeft || left + b.offsetWidth > strip.scrollLeft + strip.clientWidth) {
        strip.scrollLeft = left - strip.clientWidth / 2 + b.offsetWidth / 2;
      }
    }
    const selection = picking ? [i === state.blinkA ? 'A' : '', i === state.blinkB ? 'B' : ''].filter(Boolean).join('/') : '';
    b.classList.toggle('current', !picking && on);
    b.dataset.selection = selection;
    b.setAttribute('aria-label', `${fmtDate(fr[i].date)}${selection ? `, selected as ${selection}` : ''}`);
  }
}

// ---------- playback ----------

let timer = null;
function play() {
  if (state.mode === 'compare') return;
  if (loaded().length < 2) return;
  state.playing = true;
  $('playBtn').classList.add('playing');
  $('playBtn').setAttribute('aria-label', 'Pause');
  $('fullscreenPlay').textContent = 'Pause';
  clearInterval(timer);
  const blink = state.mode === 'blink';
  timer = setInterval(() => {
    if (state.mode === 'blink') state.blinkPhase ^= 1;
    else state.idx = (state.idx + 1) % loaded().length;
    draw();
  }, 1000 / (blink ? Math.max(1, state.fps / 2) : state.fps));
}

function stop() {
  state.playing = false;
  clearInterval(timer);
  $('playBtn').classList.remove('playing');
  $('playBtn').setAttribute('aria-label', 'Play');
  $('fullscreenPlay').textContent = 'Play';
}

function step(d) {
  stop();
  const n = loaded().length;
  if (!n) return;
  if (state.mode === 'compare') return;
  if (state.mode === 'blink') state.blinkPhase ^= 1;
  else { if (state.mode === 'motion' || state.mode === 'static') setMode('play'); state.idx = (state.idx + d + n) % n; }
  draw();
}

// ---------- export ----------

const EXPORT_PX = 720;

function exportCanvas() {
  const c = document.createElement('canvas');
  c.width = c.height = EXPORT_PX;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  return [c, g];
}

function stamp(g) {
  g.drawImage(canvas, 0, 0, EXPORT_PX, EXPORT_PX);
  g.font = '500 20px Inter, sans-serif';
  g.fillStyle = 'rgba(7,6,13,0.7)';
  const label = $('hudDate').textContent;
  g.fillRect(12, 12, g.measureText(label).width + 20, 34);
  g.fillStyle = '#ece9ff';
  g.fillText(label, 22, 36);
  g.font = '13px Inter, sans-serif';
  g.fillStyle = 'rgba(236,233,255,0.75)';
  const credit = `SPHEREx ${DETECTORS[state.band].name} · ${state.target.name || ''} · NASA/JPL-Caltech/IPAC`;
  g.fillText(credit, 14, EXPORT_PX - 14);
}

function download(blob, ext) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `spherex-${(state.target?.name || 'sky').replace(/\W+/g, '-').toLowerCase()}-${DETECTORS[state.band].name}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

$('pngBtn').addEventListener('click', () => {
  if (!loaded().length) return;
  const [c, g] = exportCanvas();
  stamp(g);
  c.toBlob(b => download(b, 'png'));
});

$('videoBtn').addEventListener('click', async () => {
  const fr = loaded();
  if (fr.length < 2 || !window.MediaRecorder) { toast('Video export needs at least two frames and a modern browser.'); return; }
  const btn = $('videoBtn');
  btn.disabled = true;
  stop();
  const mode = state.mode === 'motion' || state.mode === 'static' || state.mode === 'compare' ? 'play' : state.mode;
  if (mode !== state.mode) setMode(mode);
  const [c, g] = exportCanvas();
  const mime = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(c.captureStream(30), { mimeType: mime, videoBitsPerSecond: 6e6 });
  const chunks = [];
  rec.ondataavailable = e => chunks.push(e.data);
  const done = new Promise(r => { rec.onstop = r; });
  rec.start();
  const steps = mode === 'blink' ? 8 : fr.length;
  const saved = [state.idx, state.blinkPhase];
  for (let i = 0; i < steps; i++) {
    btn.textContent = `${Math.round((100 * i) / steps)}%`;
    if (mode === 'blink') state.blinkPhase = i % 2; else state.idx = i;
    draw();
    stamp(g);
    await new Promise(r => setTimeout(r, 1000 / (mode === 'blink' ? Math.max(1, state.fps / 2) : state.fps)));
  }
  rec.stop();
  await done;
  [state.idx, state.blinkPhase] = saved;
  draw();
  btn.textContent = 'Video';
  btn.disabled = false;
  download(new Blob(chunks, { type: mime }), mime.startsWith('video/mp4') ? 'mp4' : 'webm');
});

// ---------- controls ----------

function renderWaveStatus() {
  const all = allLoaded(), filtered = loaded();
  $('waveStatus').textContent = state.window
    ? `${filtered.length} of ${all.length} loaded visits match ${state.window.min}-${state.window.max} micrometres at the target. Every exposure must match; unknown wavelengths are excluded. Approximate centers only, not calibrated matched bands.${filtered.length < 2 ? ' Fewer than two visits: widen the window to compare dates.' : ''}`
    : 'No wavelength filter. D1-D6 are detector ranges, not 102 separate channels.';
}

function applyWindow(window) {
  stop();
  state.restore = null;
  state.restoreFailed = state.restoredEpoch = false;
  state.window = window;
  state.idx = 0;
  state.blinkAFrame = loaded()[0] || null;
  state.blinkBFrame = loaded()[1] || null;
  state.blinkA = state.blinkAFrame ? 0 : -1;
  state.blinkB = state.blinkBFrame ? 1 : -1;
  state.template = state.comparison = state.lcPoints = null;
  state.changes = state.tracks = null;
  state.mark = state.markTrack = null;
  state.scanTemplate = null;
  $('restoreNote').textContent = 'Wavelength selection changed; date selections and scan results were reset. Choose A and B again before interpreting a residual.';
  renderChanges();
  recomputeLimits();
  drawAll();
  drawOverlay();
  writeHash();
}

$('waveForm').addEventListener('submit', event => {
  event.preventDefault();
  try { applyWindow(wavelengthWindow(Number($('waveMin').value), Number($('waveMax').value))); }
  catch (error) { $('waveStatus').textContent = error.message; }
});
$('waveClear').addEventListener('click', () => applyWindow(null));

function restoreEpochs() {
  if (!state.restore) return;
  const saved = state.restore, fr = loaded(), missing = [];
  for (const [key, ref, index] of [['epochA', 'blinkAFrame', 'blinkA'], ['epochB', 'blinkBFrame', 'blinkB']]) {
    if (!saved[key]) continue;
    state[ref] = fr.find(f => frameKey(f) === saved[key]) || null;
    state[index] = fr.indexOf(state[ref]);
    if (!state[ref]) missing.push(key);
  }
  if (saved.epoch) {
    const index = fr.findIndex(f => frameKey(f) === saved.epoch);
    if (index >= 0) state.idx = index;
    else missing.push('current visit');
  }
  if (saved.probe) {
    if (saved.probe.some(v => v >= state.size)) missing.push('probe outside the field');
    else if (!missing.includes('current visit')) setProbe(...saved.probe, false);
  }
  state.restoreFailed = missing.length > 0;
  state.restoredEpoch = !!(saved.epoch || saved.epochA || saved.epochB);
  $('restoreNote').textContent = missing.length
    ? `Shared selection unavailable (${missing.join(', ')}): exposure failed, is outside the wavelength window, or is no longer in this index. No substitute A/B visit was selected.`
    : state.restoredEpoch ? 'Shared exposure identities and display settings restored.' : '';
  state.restore = null;
  drawAll();
}

function summaryFor(frame) {
  if (!qualityCache.has(frame)) qualityCache.set(frame, qualitySummary(frame, state.size));
  return qualityCache.get(frame);
}

function renderInspector() {
  if (!$('qualityInspector').open) return;
  const frame = currentFrame();
  const composite = ['static', 'motion', 'compare'].includes(state.mode);
  if (!frame || composite) {
    inspectedFrame = null;
    $('qualityDetails').textContent = composite ? 'Choose Time-lapse or Blink to inspect the quality and provenance of a single visit.' : 'No loaded visit matches the current selection.';
    return;
  }
  if (inspectedFrame === frame) return;
  inspectedFrame = frame;
  const q = summaryFor(frame);
  const values = frame.analysisCuts.map(c => spectrumAtCut(c)).filter(Boolean);
  $('qualityDetails').innerHTML = `<dl>
    <dt>Visit (UTC)</dt><dd>${escapeHtml(frame.date.toISOString())}</dd>
    <dt>Conservative common quality support</dt><dd>${q.known ? `${q.valid} / ${q.total} pixels (${(100 * q.valid / q.total).toFixed(1)}%)` : 'Unknown: FLAGS unavailable for one or more exposures'}</dd>
    <dt>Metadata completeness</dt><dd>${q.complete ? 'FLAGS and wavelength tables loaded; comparison checks still apply' : escapeHtml(frame.qualityError || frame.waveError || 'Incomplete exposure, quality or wavelength data; analysis unavailable')}</dd>
    <dt>Approximate target wavelengths / bandwidths</dt><dd>${values.length ? values.map(v => `${v.lam.toFixed(4)} / ${v.bw.toFixed(4)} micrometres`).join('; ') : 'Unavailable'}</dd></dl>
    <p>Flagged output support samples across loaded exposures (${q.supportSamples} samples; categories can overlap):</p>
    <ul>${q.counts.map((count, bit) => count ? `<li>${escapeHtml(flagLabel(bit))}: ${count}</li>` : '').join('') || `<li>${q.known ? 'No flag bits set in sampled support. Image edges and non-finite pixels can still be rejected.' : 'Unknown; missing flags are not treated as clean.'}</li>`}</ul>
    <p>Source FITS files (${frame.analysisCuts.length} of ${frame.exposures.length} exposures loaded):</p>
    <ul>${frame.exposures.map(e => `<li><a href="${escapeHtml(e.url)}" target="_blank" rel="noopener">${escapeHtml(e.id)}</a></li>`).join('')}</ul>
    ${(frame.exposureIssues || []).map(issue => `<p>${escapeHtml(issue.id)} (${escapeHtml(issue.stage)}): ${escapeHtml(issue.message)}</p>`).join('')}`;
}

function drawQualityOverlay() {
  const overlay = $('qualityOverlay'), g = overlay.getContext('2d');
  overlay.width = overlay.height = state.size;
  const frame = currentFrame();
  if (!state.qualityMask || !frame || !['play', 'blink'].includes(state.mode)) return;
  const pixels = g.createImageData(state.size, state.size);
  const cuts = frame.analysisCuts || [];
  for (let k = 0; k < state.size * state.size; k++) {
    if (!cuts.length || cuts.some(c => !c.analysis || !Number.isFinite(c.analysis[k]))) {
      pixels.data.set([255, 164, 64, 115], k * 4);
    }
  }
  g.putImageData(pixels, 0, 0);
}
$('qualityInspector').addEventListener('toggle', renderInspector);
$('qualityMask').addEventListener('change', e => { state.qualityMask = e.target.checked; drawQualityOverlay(); writeHash(); });

function renderTargetGuide() {
  const guide = challengeGuide(state.target), element = $('targetGuide');
  element.hidden = !guide;
  if (!guide) return;
  const count = allLoaded().length;
  element.innerHTML = `<strong>Challenge target guide</strong><p>${escapeHtml(guide.guide)}</p><p><small>${escapeHtml(guide.caveat)}</small></p><p>${count} visits loaded in this session. Loading images does not verify the target or establish a change.</p>`;
}

function observationManifest() {
  writeHash();
  return {
    schema: 'spherex-observation/v1', exportedAt: new Date().toISOString(), viewURL: location.href,
    target: state.target, indexedAt: archiveIndex?.updated || null,
    tracking: state.track ? { query: state.track.query, name: state.track.name, precise: state.track.precise, source: state.track.source || null } : null,
    indexedCollections: archiveIndex ? [...new Set(archiveIndex.folders.map(f => f.split('/')[0]))] : [],
    archive: archiveIndex ? summarizeIndex(archiveIndex) : null,
    settings: Object.fromEntries(encodeSettings({ ...state, epochA: frameKey(state.blinkAFrame), epochB: frameKey(state.blinkBFrame), epoch: frameKey(currentFrame()) })),
    notes: 'Exploratory only, not calibrated photometry or detection significance. Empty/missing quality is not clean. Output flags summarize four native interpolation support pixels.',
    frames: state.frames.map(f => ({
      identity: frameKey(f), date: f.date.toISOString(), status: f.status, center: state.target ? centreOf(f) : null,
      wavelengthWindowIncluded: f.status === 'ok' ? inWavelengthWindow(f, state.window) : false,
      exposures: f.exposures.map(e => ({ id: e.id, detector: e.detector, mjd: e.mjd, url: e.url,
        center: e.obj ? [e.obj.ra, e.obj.dec] : state.target ? [state.target.ra, state.target.dec] : null })),
      quality: f.status === 'ok' ? summaryFor(f) : null,
      qualityError: f.qualityError || null, wavelengthError: f.waveError || null,
      spectra: (f.analysisCuts || []).map(c => ({ exposureId: c.exposureId, spectrum: spectrumAtCut(c) })),
      exposureIssues: f.exposureIssues || [],
      analysisMetadataUnavailable: f.analysisError ?? true,
    })),
    scan: { completed: !!state.changes, selectedVisits: state.scanCount, consideredVisits: state.scanTotal },
    challengeChecks: validationResults,
  };
}
$('shareView').addEventListener('click', async () => {
  writeHash();
  try {
    await navigator.clipboard.writeText(location.href);
    $('restoreNote').textContent = 'View link copied, including exact A/B visits, wavelength window and display settings.';
  } catch (error) {
    $('restoreNote').textContent = `Clipboard unavailable: ${error.message}. Copy the complete URL from the address bar; it now contains this selection.`;
  }
});
$('exportObservation').addEventListener('click', () => download(new Blob([JSON.stringify(observationManifest(), null, 2)], { type: 'application/json' }), 'json'));
$('candidateCsv').addEventListener('click', () => {
  if (!state.changes) return;
  writeHash();
  const data = candidateCSV(state.changes, { band: state.band, positionAt: pixSky, viewURL: location.href });
  download(new Blob([data], { type: 'text/csv' }), 'candidates.csv');
});

for (const guide of CHALLENGE_GUIDES) {
  const section = document.createElement('div');
  section.className = 'challenge-guide';
  const heading = document.createElement('strong'); heading.textContent = guide.name;
  const instruction = document.createElement('p'); instruction.textContent = guide.guide + ' ' + guide.caveat;
  const button = document.createElement('button'); button.type = 'button'; button.className = 'control-jump'; button.textContent = `Explore ${guide.name}`;
  button.onclick = async () => {
    $('q').value = guide.name; $('searchMode').value = 'place'; updatePlaceholder();
    await lookAt(guide.name, { ...guide, note: guide.caveat });
    $('viewer').scrollIntoView({ block: 'start' });
  };
  section.append(heading, instruction, button);
  $('challengeGuides').appendChild(section);
}
let checksAbort = null;
function appendCheckReport(report) {
  const li = document.createElement('li');
  li.textContent = `${report.target}: ${report.outcome}. ${report.error || report.comparisonUnavailable || ''} ${report.coverageWarning || ''}`.trim();
  $('checkResults').appendChild(li);
}
try {
  const saved = localStorage.getItem('spherex-challenge-checks');
  if (saved) {
    const record = JSON.parse(saved);
    if (record.schema !== 'spherex-challenge-checks/v1' || !Array.isArray(record.results) || record.results.length > 5 ||
        record.results.some(r => !r || !CHALLENGE_GUIDES.some(g => g.name === r.target) || typeof r.outcome !== 'string')) throw new Error('Unrecognized saved check results.');
    validationResults.push(...record.results);
    validationResults.forEach(appendCheckReport);
    $('exportChecks').disabled = !validationResults.length;
    $('checksStatus').textContent = `Saved outcomes for ${validationResults.length} targets, last checked ${validationResults.at(-1)?.checkedAt || 'at an unknown time'}. Rerun to refresh; saved results are not a detection claim.`;
  }
} catch (error) {
  $('checksStatus').textContent = `Saved checks unavailable: ${error.message}. Run new checks to obtain current results.`;
}
$('cancelChecks').onclick = () => checksAbort?.abort();
$('runChecks').addEventListener('click', async () => {
  checksAbort = new AbortController();
  const { signal } = checksAbort;
  validationResults.length = 0;
  $('checkResults').replaceChildren();
  $('runChecks').disabled = true;
  $('exportChecks').disabled = true;
  $('cancelChecks').hidden = false;
  let storageError = '';
  try { localStorage.removeItem('spherex-challenge-checks'); }
  catch (error) { storageError = error.message; }
  for (const guide of CHALLENGE_GUIDES) {
    if (signal.aborted) break;
    $('checksStatus').textContent = `Checking ${guide.name} (${validationResults.length + 1} of 5)...`;
    let report;
    try { report = await validateTarget(guide, findExposuresDetailed, AbortSignal.any([signal, AbortSignal.timeout(90000)])); }
    catch (error) {
      if (signal.aborted) break;
      report = { target: guide.name, checkedAt: new Date().toISOString(), outcome: 'Failed', error: error.message };
    }
    validationResults.push(report);
    appendCheckReport(report);
    try { localStorage.setItem('spherex-challenge-checks', JSON.stringify({ schema: 'spherex-challenge-checks/v1', results: validationResults })); }
    catch (error) { storageError = error.message; }
    $('exportChecks').disabled = false;
  }
  $('checksStatus').textContent = `${signal.aborted ? 'Cancelled' : 'Finished'}: ${validationResults.length} of 5 targets checked. Results describe sampled data availability, not verified detections. Export includes dates, source files and failures.${storageError ? ` Browser storage unavailable (${storageError}); export now to preserve results.` : ' Results saved in this browser with their check timestamps.'}`;
  $('runChecks').disabled = false;
  $('cancelChecks').hidden = true;
});
$('exportChecks').onclick = () => {
  const a = document.createElement('a'), url = URL.createObjectURL(new Blob([JSON.stringify({ schema: 'spherex-challenge-checks/v1', results: validationResults }, null, 2)], { type: 'application/json' }));
  a.href = url; a.download = 'spherex-challenge-checks.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const fullscreenButton = $('fullscreenBtn');
if (!document.fullscreenEnabled || !$('viewer').requestFullscreen) {
  fullscreenButton.disabled = true;
  fullscreenButton.title = 'Full screen is unavailable in this browser or embedded preview.';
}
fullscreenButton.addEventListener('click', async () => {
  try {
    await $('viewer').requestFullscreen();
  } catch (error) {
    toast(`Could not open full screen: ${error.message}`);
  }
});
$('fullscreenExit').addEventListener('click', async () => {
  try {
    await document.exitFullscreen();
  } catch (error) {
    toast(`Could not exit full screen: ${error.message}. Press Escape to return.`);
  }
});
let wasViewerFullscreen = false;
document.addEventListener('fullscreenchange', () => {
  const active = document.fullscreenElement === $('viewer');
  if (active) $('viewer').focus({ preventScroll: true });
  else if (wasViewerFullscreen) fullscreenButton.focus({ preventScroll: true });
  wasViewerFullscreen = active;
});
$('fullscreenPlay').addEventListener('click', () => { state.playing ? stop() : play(); draw(); });
$('fullscreenPrev').addEventListener('click', () => step(-1));
$('fullscreenNext').addEventListener('click', () => step(1));

for (const button of document.querySelectorAll('[data-scroll-target]')) {
  button.addEventListener('click', () => {
    const target = $(button.dataset.scrollTarget);
    target.scrollIntoView({ block: 'start' });
    target.focus({ preventScroll: true });
  });
}

function renderBands() {
  const counts = bandCounts();
  $('bands').innerHTML = '';
  for (const [k, d] of Object.entries(DETECTORS)) {
    const b = document.createElement('button');
    b.className = 'band';
    b.type = 'button';
    b.dataset.band = k;
    b.style.setProperty('--c', d.color);
    b.disabled = !counts[k];
    b.setAttribute('aria-pressed', String(Number(k) === state.band));
    b.setAttribute('aria-label', `${d.name}, ${d.range}, ${counts[k] || 0} archive images`);
    b.title = `${d.name} · ${d.range} · ${counts[k] || 0} archive images`;
    b.textContent = d.name;
    b.onclick = () => { state.band = Number(k); renderBands(); loadBand(); };
    $('bands').appendChild(b);
  }
  const detector = DETECTORS[state.band];
  $('bandInfo').innerHTML = '<span class="band-wavelength"></span> <span class="band-count"></span>';
  $('bandInfo').querySelector('.band-wavelength').textContent = `${detector.name} · ${detector.range}`;
  $('bandInfo').querySelector('.band-count').textContent = counts[state.band]
    ? `${counts[state.band]} archive images`
    : 'No archive images in this band';
  renderCoverageChart();
}

// Release scope of the loaded index, or null before it has loaded.
function indexSummary() {
  return archiveIndex ? summarizeIndex(archiveIndex) : null;
}

function renderCoverageChart() {
  const section = $('coverageSection');
  section.hidden = !state.target && !state.coverageNote;
  renderCoverage($('coverageChart'), { exposures: state.exposures, band: state.band, detectors: DETECTORS, onPick: pickCoverage });
  $('coverageSummary').textContent = state.exposures.length
    ? coverageSummary(state.exposures, indexSummary())
    : state.coverageNote || noCoverageMessage(indexSummary());
  $('coverageWarning').hidden = !state.coverageNote;
  $('coverageWarning').textContent = state.coverageNote || '';
}

// Coverage chart click: switch detector, or jump to the nearest loaded date.
function pickCoverage(detector, mjd) {
  if (detector !== state.band) { state.band = detector; renderBands(); loadBand(); return; }
  const best = nearestIndex(loaded(), mjd);
  if (best < 0) return;
  stop();
  if (state.mode === 'motion' || state.mode === 'static') setMode('play');
  state.idx = best;
  draw();
}

function renderSizes() {
  for (const b of $('sizes').children) b.setAttribute('aria-pressed', String(Number(b.dataset.size) === state.size));
}

function renderModes() {
  for (const b of $('modes').querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
  $('modeHint').textContent = (state.track && TRACK_HINTS[state.mode]) || MODE_HINTS[state.mode];
}

function setMode(m) {
  const wasPlaying = state.playing;
  stop();
  state.mode = m;
  state.blinkPhase = 0;
  renderModes();
  writeHash();
  draw();
  if (wasPlaying && (m === 'play' || m === 'diff' || m === 'blink')) play();
  else if (m === 'blink') play();
}

$('modes').addEventListener('click', e => {
  const m = e.target.closest('button')?.dataset.mode;
  if (m) setMode(m);
});

$('sizes').addEventListener('click', e => {
  const s = Number(e.target.closest('button')?.dataset.size);
  if (!s || s === state.size) return;
  state.size = s;
  renderSizes();
  if (state.exposures.length) loadBand();
});

$('mask').addEventListener('change', e => { state.mask = e.target.checked; if (state.exposures.length) loadBand(); });
$('groupDay').addEventListener('change', e => { state.group = e.target.checked; if (state.exposures.length) loadBand(); });

for (const id of ['stretch', 'cmap']) {
  $(id).addEventListener('change', e => { state[id] = e.target.value; drawAll(); });
}
$('contrast').addEventListener('input', e => { state.contrast = Number(e.target.value); recomputeLimits(); draw(); });
$('contrast').addEventListener('change', () => renderFilmstrip());
$('invert').addEventListener('change', e => { state.invert = e.target.checked; drawAll(); });
$('crosshair').addEventListener('change', e => { state.crosshair = e.target.checked; drawOverlay(); });

$('playBtn').addEventListener('click', () => { state.playing ? stop() : play(); draw(); });
$('prevBtn').addEventListener('click', () => step(-1));
$('nextBtn').addEventListener('click', () => step(1));
$('speed').addEventListener('input', e => {
  state.fps = Number(e.target.value);
  $('speedVal').textContent = `${state.fps} fps`;
  if (state.playing) play();
});

$('blinkPick').addEventListener('click', e => {
  const pick = e.target.closest('[data-pick]')?.dataset.pick;
  if (!pick) return;
  state.pickEpoch = pick;
  updateTimelineMarks();
});

$('timeline').addEventListener('click', e => {
  state.restore = null;
  const fr = loaded();
  if (!fr.length) return;
  const rect = $('ticks').getBoundingClientRect();
  const [t0, t1] = timeRange();
  const mjd = t0 + ((e.clientX - rect.left) / rect.width) * (t1 - t0);
  let best = 0;
  fr.forEach((f, i) => { if (Math.abs(f.mjd - mjd) < Math.abs(fr[best].mjd - mjd)) best = i; });
  if (state.mode === 'blink' || state.mode === 'compare') {
    if (e.shiftKey || state.pickEpoch === 'B') { state.blinkB = best; state.blinkBFrame = fr[best]; }
    else { state.blinkA = best; state.blinkAFrame = fr[best]; }
  } else {
    stop();
    if (state.mode === 'motion' || state.mode === 'static') setMode('play');
    state.idx = best;
  }
  draw();
});

$('filmstrip').addEventListener('click', e => {
  const b = e.target.closest('.thumb');
  if (!b) return;
  state.restore = null;
  stop();
  const i = Number(b.dataset.i);
  if (state.mode === 'blink' || state.mode === 'compare') {
    if (e.shiftKey || state.pickEpoch === 'B') { state.blinkB = i; state.blinkBFrame = loaded()[i]; }
    else { state.blinkA = i; state.blinkAFrame = loaded()[i]; }
  } else {
    if (state.mode === 'motion' || state.mode === 'static') setMode('play');
    state.idx = i;
  }
  draw();
});

$('imageSurface').addEventListener('mousemove', e => {
  if (!state.target) return;
  const r = canvas.getBoundingClientRect();
  const n = state.size;
  const i = Math.floor(((e.clientX - r.left) / r.width) * n);
  const j = Math.floor(((e.clientY - r.top) / r.height) * n);
  if (i < 0 || j < 0 || i >= n || j >= n) return;
  const s = (PIXEL_ARCSEC / 3600) * D2R, half = (n - 1) / 2;
  const f = currentFrame();
  const [hra, hdec] = centreOf(state.mode === 'motion' || state.mode === 'static' ? null : f);
  const [ra, dec] = tanDeproject([hra * D2R, hdec * D2R], -(i - half) * s, (half - j) * s);
  let v = f && state.mode !== 'motion' ? (state.mode === 'static' ? getTemplate() : f.data)[j * n + i] : NaN;
  if (state.mode === 'compare') {
    const r = state.comparison?.result;
    const k = j * n + i;
    v = r ? r.frames[1].data[k] - r.frames[0].data[k] : NaN;
  }
  $('hudCursor').textContent = `${formatRA(ra)} ${formatDec(dec)}${v === v ? `  ${v.toFixed(3)} MJy/sr` : ''}`;
});
$('imageSurface').addEventListener('mouseleave', () => { $('hudCursor').textContent = ''; });

document.addEventListener('keydown', e => {
  if (e.target.closest('input, select, textarea, button, summary, a') || $('workspace').hidden) return;
  if (e.key === 'ArrowRight') step(1);
  else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === ' ') { e.preventDefault(); state.playing ? stop() : play(); draw(); }
  else if (e.key === 'b') setMode('blink');
  else if (e.key === 'd') setMode('diff');
});

$('search').addEventListener('submit', e => {
  e.preventDefault();
  const q = $('q').value.trim();
  if (!q) return;
  if ($('searchMode').value === 'track') lookAt(q, { track: q });
  else lookAt(q);
});

// Settings
$('settingsBtn').addEventListener('click', () => {
  $('maxFrames').value = state.maxFrames;
  $('settings').showModal();
});
$('settings').addEventListener('close', () => {
  if ($('settings').returnValue !== 'save') return;
  state.maxFrames = Math.max(4, Math.min(400, Number($('maxFrames').value) || 80));
  try { localStorage.setItem('maxFrames', state.maxFrames); } catch {}
  if (state.exposures.length) loadBand();
});

// Examples
const CHALLENGE_TARGETS = new Set(["Barnard's Star", 'Epsilon Indi B', 'WISE 0855', 'RW Aurigae', 'R Draconis']);
for (const ex of EXAMPLES) {
  const b = document.createElement('button');
  b.type = 'button';
  if (ex.feature) {
    b.className = 'destination';
    b.dataset.scene = ex.feature;
    b.innerHTML = '<span class="destination-art" aria-hidden="true"></span><span class="destination-copy"><small></small><strong></strong><span></span></span><span class="destination-arrow" aria-hidden="true">↗</span>';
    b.querySelector('small').textContent = ex.name;
    b.querySelector('strong').textContent = ex.headline;
    b.querySelector('.destination-copy > span').textContent = ex.invitation;
  } else {
    b.className = 'example';
    b.innerHTML = '<strong></strong><span></span>';
    b.querySelector('strong').textContent = ex.name;
    b.querySelector('span').textContent = ex.note;
  }
  b.onclick = () => {
    $('q').value = ex.track || ex.name;
    $('searchMode').value = ex.track ? 'track' : 'place';
    updatePlaceholder();
    lookAt(ex.name, ex);
  };
  $(ex.feature ? 'featuredExamples' : CHALLENGE_TARGETS.has(ex.name) ? 'challengeExamples' : 'examples').appendChild(b);
}

function updatePlaceholder() {
  $('q').placeholder = $('searchMode').value === 'track'
    ? 'Try 3I/ATLAS or an asteroid name'
    : 'Try Orion Nebula or sky coordinates';
}
$('searchMode').addEventListener('change', updatePlaceholder);

// Start from a shared link if present
function fromHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  let settings;
  try { settings = decodeSettings(p); }
  catch (error) { toast(`Cannot restore shared view: ${error.message}`); return; }
  Object.assign(state, settings);
  state.restore = settings;
  for (const [id, key] of Object.entries({ groupDay: 'group', mask: 'mask', invert: 'invert', crosshair: 'crosshair', colourFix: 'colourFix', asteroids: 'asteroids', qualityMask: 'qualityMask' })) $(id).checked = state[key];
  for (const id of ['stretch', 'cmap', 'contrast', 'astMag']) $(id).value = state[id];
  $('speed').value = state.fps;
  $('speedVal').textContent = `${state.fps} fps`;
  $('contextCatalog').value = state.context;
  $('waveMin').value = state.window?.min ?? 0.75;
  $('waveMax').value = state.window?.max ?? 5;
  const ra = Number(p.get('ra')), dec = Number(p.get('dec'));
  if ((p.has('band') && ![1, 2, 3, 4, 5, 6].includes(Number(p.get('band')))) ||
      (p.has('fov') && ![48, 96, 160, 240].includes(Number(p.get('fov')))) ||
      (p.has('view') && !MODE_HINTS[p.get('view')]) || p.has('ra') !== p.has('dec') ||
      (p.has('ra') && (!p.get('ra').trim() || !p.get('dec').trim())) ||
      (p.has('ra') && (!Number.isFinite(ra) || ra < 0 || ra >= 360)) ||
      (p.has('dec') && (!Number.isFinite(dec) || dec < -90 || dec > 90))) {
    toast('Cannot restore shared view: invalid detector, field size or sky coordinates.'); return;
  }
  const opts = {
    shared: true,
    band: Number(p.get('band')) || undefined,
    size: Number(p.get('fov')) || undefined,
    mode: MODE_HINTS[p.get('view')] ? p.get('view') : undefined,
  };
  if (settings.probe && settings.probe.some(v => v >= (opts.size || state.size))) {
    toast('Cannot restore shared view: probe lies outside the selected field.'); return;
  }
  if (p.get('track')) {
    $('q').value = p.get('track');
    $('searchMode').value = 'track';
    updatePlaceholder();
    lookAt(p.get('track'), { ...opts, track: p.get('track') });
  } else if (p.has('ra') && p.has('dec') && Number.isFinite(ra) && Number.isFinite(dec)) {
    const name = p.get('name');
    $('q').value = name || `${ra} ${dec}`;
    lookAt(name || '', { ...opts, ra, dec, name });
  } else if (p.get('name')) {
    $('q').value = p.get('name');
    lookAt(p.get('name'), opts);
  }
}

renderModes();
renderSizes();
fromHash();

loadIndex().then(ix => {
  archiveIndex = ix;
  if (state.target) renderCoverageChart();
  const summary = summarizeIndex(ix), freshness = summary.freshness;
  const updated = freshness.status === 'known' ? `${freshness.updatedAt} (${Math.floor(freshness.ageMs / 86400000)} days ago)` : 'unknown';
  $('stats').textContent = `${ix.total.toLocaleString()} indexed detector-image records · updated ${updated}`;
  $('archiveStatus').textContent = `${summary.collections.map(c => `${c.name} (${c.folderCount} folders)`).join(', ')}. ${ix.total.toLocaleString()} indexed detector-image records; ${summary.versionCount} processing versions. Index updated: ${updated}. ${summary.refreshProvenance ? `Build provenance: ${JSON.stringify(summary.refreshProvenance)}.` : 'Legacy index: detailed build provenance unavailable.'} DR1 paths are supported by the builder${summary.collections.some(c => c.name === 'spherex_dr1') ? ' and DR1 is indexed.' : ', but DR1 is not present in this index; rebuild and publish to include it.'} Footprint counts are not validated target detections.`;
}).catch(error => {
  $('archiveStatus').textContent = `Index provenance unavailable: ${error.message}. Retry the page before relying on coverage counts.`;
});
