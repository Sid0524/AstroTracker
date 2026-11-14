import { lookup } from './wave.js';

export const frameKey = frame => frame?.exposures.map(e => e.url
  ? `${e.id}@${new URL(e.url).pathname.replace(/^\/nasa-irsa-spherex\//, '/')}` : e.id).join(',') || '';

export function spectrumAtCut(cut, point = null, size = 0) {
  const xy = point && cut.pixels ? 2 * (point[1] * size + point[0]) : null;
  const [x, y] = xy === null ? cut.pix || [] : [cut.pixels[xy], cut.pixels[xy + 1]];
  const t = cut.wave;
  if (!t || !Number.isFinite(x) || !Number.isFinite(y) ||
      x + 1 < t.xs[0] || x + 1 > t.xs.at(-1) || y + 1 < t.ys[0] || y + 1 > t.ys.at(-1)) return null;
  const v = lookup(t, x, y);
  return Number.isFinite(v.lam) && v.lam > 0 && Number.isFinite(v.bw) && v.bw > 0 ? v : null;
}

export function inWavelengthWindow(frame, window, point = null, size = 0) {
  if (!window) return true;
  return !!frame.analysisCuts?.length && frame.analysisCuts.every(c => {
    const v = spectrumAtCut(c, point, size);
    return v && v.lam >= window.min && v.lam <= window.max;
  });
}

export function wavelengthWindow(min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0.75 || max > 5 || min >= max) {
    throw new Error('Choose a wavelength window from 0.75 to 5 micrometres, with minimum below maximum.');
  }
  return { min, max };
}

export function countFlagBits(flags) {
  const counts = Array(32).fill(0);
  for (let bits of flags) {
    bits >>>= 0;
    while (bits) {
      const bit = 31 - Math.clz32(bits & -bits);
      counts[bit]++;
      bits = (bits & (bits - 1)) >>> 0;
    }
  }
  return counts;
}

export function flagLabel(bit) {
  if (bit === 21) return 'SOURCE: retained for science, excluded from background';
  if (bit >= 22 && bit <= 24) return `Ghost contamination (bit ${bit})`;
  return ({ 25: 'Streak', 26: 'Bloom', 27: 'Snowball', 28: 'Halo', 29: 'Satellite halo' })[bit] ||
    `Detector / processing flag bit ${bit}`;
}

export function qualitySummary(frame, size) {
  const cuts = frame?.analysisCuts || [], total = size * size;
  const known = cuts.length > 0 && cuts.every(c => c.analysis && c.flagCounts);
  const counts = Array.from({ length: 32 }, (_, bit) => cuts.reduce((s, c) => s + (c.flagCounts?.[bit] || 0), 0));
  let valid = 0;
  if (known) for (let k = 0; k < total; k++) if (cuts.every(c => Number.isFinite(c.analysis[k]))) valid++;
  return { known, valid: known ? valid : null, total, counts, supportSamples: cuts.length * total,
    complete: known && !frame.analysisError };
}

export function csv(rows) {
  return rows.map(row => row.map(value => {
    let s = value === null || value === undefined ? '' : String(value);
    // Keep catalog names from being interpreted as spreadsheet formulas.
    if (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && !Number.isFinite(Number(s)))) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n') + '\r\n';
}

export function candidateCSV(candidates, { band, positionAt, viewURL }) {
  const rows = [['kind', 'date_utc', 'ra_deg', 'dec_deg', 'detector', 'approx_wavelength_um', 'exploratory_score_not_significance', 'seen_in_exposures', 'known_asteroid', 'catalog_check', 'glitch', 'exposure_keys', 'source_urls', 'view_url']];
  for (const c of candidates) {
    const f = c.frameRef, [ra, dec] = positionAt(c.x, c.y);
    rows.push([c.kind, f.date.toISOString(), ra, dec, band, f.lam, c.snr, c.seenIn,
      c.known?.name || '', c.known ? 'matched' : c.known === null ? 'no match' : 'unavailable or pending', !!c.glitch,
      frameKey(f), f.exposures.map(e => e.url).join(' '), viewURL]);
  }
  return csv(rows);
}

const booleans = ['group', 'mask', 'invert', 'crosshair', 'colourFix', 'asteroids', 'qualityMask'];
export function encodeSettings(settings) {
  const p = new URLSearchParams();
  for (const key of booleans) p.set(key, settings[key] ? '1' : '0');
  for (const key of ['stretch', 'cmap', 'contrast', 'fps', 'maxFrames', 'astMag', 'context']) p.set(key, settings[key]);
  if (settings.window) { p.set('waveMin', settings.window.min); p.set('waveMax', settings.window.max); }
  for (const key of ['epochA', 'epochB', 'epoch']) if (settings[key]) p.set(key, settings[key]);
  if (settings.probe) p.set('probe', settings.probe.join(','));
  return p;
}

export function decodeSettings(p) {
  const result = {};
  for (const key of booleans) if (p.has(key)) {
    if (!['0', '1'].includes(p.get(key))) throw new Error(`Invalid shared ${key} setting.`);
    result[key] = p.get(key) === '1';
  }
  const ranges = { contrast: [0.9, 0.9995], fps: [1, 12], maxFrames: [4, 400], astMag: [16, 22] };
  for (const [key, [min, max]] of Object.entries(ranges)) if (p.has(key)) {
    const n = Number(p.get(key));
    if (!Number.isFinite(n) || n < min || n > max || (key !== 'contrast' && !Number.isInteger(n))) throw new Error(`Invalid shared ${key} setting.`);
    if (key === 'astMag' && ![16, 18, 20, 22].includes(n)) throw new Error('Invalid shared astMag setting.');
    result[key] = n;
  }
  const choices = { stretch: ['linear', 'sqrt', 'log', 'asinh'], cmap: ['gray', 'infrared', 'ice'], context: ['none', 'gaia', 'wise'] };
  for (const [key, allowed] of Object.entries(choices)) if (p.has(key)) {
    if (!allowed.includes(p.get(key))) throw new Error(`Unsupported shared ${key} setting.`);
    result[key] = p.get(key);
  }
  if (p.has('waveMin') || p.has('waveMax')) {
    if (!p.has('waveMin') || !p.has('waveMax')) throw new Error('Shared wavelength window is incomplete.');
    result.window = wavelengthWindow(Number(p.get('waveMin')), Number(p.get('waveMax')));
  }
  for (const key of ['epochA', 'epochB', 'epoch']) if (p.has(key)) {
    const value = p.get(key);
    if (!value || value.length > 1000 || /[\u0000-\u001f]/.test(value)) throw new Error('Invalid shared exposure identity.');
    result[key] = value;
  }
  if (p.has('probe')) {
    if (!/^\d+,\d+$/.test(p.get('probe'))) throw new Error('Invalid shared probe position.');
    const point = p.get('probe').split(',').map(Number);
    if (point.length !== 2 || point.some(n => !Number.isInteger(n) || n < 0 || n >= 240)) throw new Error('Invalid shared probe position.');
    result.probe = point;
  }
  return result;
}
