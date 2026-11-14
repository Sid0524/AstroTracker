// Exploratory comparisons, not calibrated subtraction or detection significance.
import { lookup } from './wave.js';
import { median, medianStack } from './render.js';

function spectralRange(values) {
  if (values.some(v => !v || !Number.isFinite(v.lam) || !Number.isFinite(v.bw) || v.lam <= 0 || v.bw <= 0)) return false;
  const wavelengths = values.map(v => v.lam), widths = values.map(v => v.bw);
  const tolerance = 0.1 * Math.min(...widths);
  return Math.max(...wavelengths) - Math.min(...wavelengths) <= tolerance &&
    Math.max(...widths) - Math.min(...widths) <= tolerance;
}

function spectrumAt(c, x, y) {
  const t = c.wave;
  if (!t || !Number.isFinite(x) || !Number.isFinite(y) ||
      x + 1 < t.xs[0] || x + 1 > t.xs.at(-1) || y + 1 < t.ys[0] || y + 1 > t.ys.at(-1)) return null;
  return lookup(t, x, y);
}

// Choose the largest greedy target-compatible set; all exclusions are reported.
export function selectCompatibleFrames(frames) {
  const eligible = frames.filter(f => !f.analysisError && f.analysisCuts?.length &&
    spectralRange(f.analysisCuts.map(c => spectrumAt(c, c.pix[0], c.pix[1]))));
  let best = [];
  for (const seed of eligible) {
    const chosen = [seed];
    let values = seed.analysisCuts.map(c => spectrumAt(c, c.pix[0], c.pix[1]));
    for (const f of eligible) {
      if (f === seed) continue;
      const next = f.analysisCuts.map(c => spectrumAt(c, c.pix[0], c.pix[1]));
      if (spectralRange([...values, ...next])) { chosen.push(f); values = [...values, ...next]; }
    }
    if (chosen.length > best.length) best = chosen;
  }
  const selected = new Set(best);
  return frames.filter(f => selected.has(f));
}

// Each frame has cuts containing strict native-support data, source flags, WCS
// positions, and a WCS-WAVE table. Every exposure participates, or none do.
export function prepareComparison(frames, size) {
  if (frames.length < 2) throw new Error('Select at least two different loaded visits.');
  const cuts = frames.flatMap(f => f.analysisCuts || []);
  if (frames.some(f => f.analysisError || !f.analysisCuts?.length)) {
    throw new Error('Quality or wavelength metadata unavailable for a visit. Retry loading, or choose other visits.');
  }
  if (!spectralRange(cuts.map(c => spectrumAt(c, c.pix[0], c.pix[1])))) {
    throw new Error('Incompatible or unavailable target wavelength/bandwidth. Choose different visits or a detector.');
  }
  const n = size * size;
  const valid = new Uint8Array(n), background = new Uint8Array(n);
  let qualityCount = 0;
  for (let k = 0; k < n; k++) {
    if (cuts.some(c => !c.analysis || !c.source || !c.pixels || !Number.isFinite(c.analysis[k]))) continue;
    qualityCount++;
    if (!spectralRange(cuts.map(c => spectrumAt(c, c.pixels[2 * k], c.pixels[2 * k + 1])))) continue;
    valid[k] = 1;
    background[k] = cuts.every(c => !c.source[k]) ? 1 : 0;
  }
  // Guard the cutout and any masked/spectral boundary by one output pixel.
  const guarded = new Uint8Array(n);
  let overlap = 0, bgCount = 0;
  for (let y = 1; y < size - 1; y++) for (let x = 1; x < size - 1; x++) {
    const k = y * size + x;
    let safe = true;
    for (let dy = -1; dy <= 1 && safe; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!valid[k + dy * size + dx]) { safe = false; break; }
    }
    if (safe) { guarded[k] = 1; overlap++; if (background[k]) bgCount++; }
  }
  if (overlap < 64 || overlap < n * 0.25) {
    throw new Error(qualityCount >= n * 0.25
      ? 'Insufficient common quality-valid, spectrally compatible overlap. Choose other visits or a field.'
      : 'Insufficient common quality-valid overlap. Choose other visits or a field.');
  }
  if (bgCount < 64 || bgCount < overlap * 0.1) {
    throw new Error('Insufficient common source-free background. Try a wider or less crowded field.');
  }
  const prepared = frames.map(f => {
    const parts = f.analysisCuts.map(c => {
      const sky = [];
      for (let k = 0; k < n; k++) if (guarded[k] && background[k]) sky.push(c.analysis[k]);
      const offset = median(sky);
      return Float32Array.from(c.analysis, (v, k) => guarded[k] ? v - offset : NaN);
    });
    const data = Float32Array.from({ length: n }, (_, k) => guarded[k]
      ? parts.reduce((sum, p) => sum + p[k], 0) / parts.length : NaN);
    return { ...f, data, parts: parts.length > 1 ? parts : null };
  });
  return { frames: prepared, template: medianStack(prepared.map(f => f.data)), overlap, background: bgCount };
}
