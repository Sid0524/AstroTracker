import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareComparison, selectCompatibleFrames } from '../js/analysis.js';
import { strictSample } from '../js/cutout.js';
import { SOURCE_FLAG } from '../js/fits.js';
import { findChanges } from '../js/detect.js';

const n = 48;
function cut(offset = 0, lam = 2, bw = 0.1) {
  const pixels = new Float32Array(n * n * 2);
  for (let k = 0; k < n * n; k++) { pixels[2 * k] = k % n; pixels[2 * k + 1] = Math.floor(k / n); }
  return {
    analysis: Float32Array.from({ length: n * n }, (_, k) => offset + ((k * 17 % 31) - 15) * 0.001),
    source: new Uint8Array(n * n), pixels, pix: [n / 2, n / 2],
    wave: { xs: [1, n], ys: [1, n], vals: [lam, bw, lam, bw, lam, bw, lam, bw] },
  };
}
const frames = (...cuts) => cuts.map(c => ({ analysisCuts: [c] }));

test('strict interpolation retains SOURCE but rejects contaminated native support and edges', () => {
  const rows = { data: Float32Array.from({ length: 64 }, () => 4) };
  const flags = new Int32Array(64);
  flags[2 * 8 + 2] = SOURCE_FLAG;
  assert.deepEqual(strictSample(rows, flags, 2.3, 2.3, 8, 8, 0, 8), { value: 4, source: 1 });
  flags[2 * 8 + 3] = 1 << 22;
  assert.ok(Number.isNaN(strictSample(rows, flags, 2.3, 2.3, 8, 8, 0, 8).value));
  assert.ok(Number.isNaN(strictSample(rows, flags, 0, 2, 8, 8, 0, 8).value));
});

test('source-free common background removes offsets without removing a real change', () => {
  const a = cut(10), b = cut(15), c = cut(20);
  for (let k = 0; k < n * n; k++) c.analysis[k] += ((k * 73 % 47) - 23) * 0.0001;
  for (let y = 21; y <= 27; y++) for (let x = 21; x <= 27; x++) {
    const k = y * n + x;
    a.source[k] = b.source[k] = c.source[k] = 1;
    if (Math.abs(x - 24) <= 2 && Math.abs(y - 24) <= 2) c.analysis[k] += 20 * Math.exp(-((x - 24) ** 2 + (y - 24) ** 2) / 1.5);
  }
  const result = prepareComparison(frames(a, b, c), n);
  const data = result.frames.map(f => f.data);
  assert.ok(Math.abs(data[1][10 * n + 10] - data[0][10 * n + 10]) < 0.00001);
  assert.ok(data[2][24 * n + 24] - data[0][24 * n + 24] > 19.9);
  const found = findChanges(result.frames, result.template, n);
  assert.ok(found.some(v => v.frame === 2 && Math.abs(v.x - 24) <= 1 && Math.abs(v.y - 24) <= 1));
  const unchanged = prepareComparison(frames(cut(10), cut(15), cut(20)), n);
  assert.equal(findChanges(unchanged.frames, unchanged.template, n).length, 0);
});

test('unknown quality, incompatible spectra and inadequate overlap or background block analysis', () => {
  assert.throws(() => prepareComparison([{ analysisError: true }, ...frames(cut())], n), /unavailable/);
  assert.throws(() => prepareComparison(frames(cut(), cut(0, 2.02)), n), /wavelength/);
  assert.throws(() => prepareComparison(frames(cut(), cut(0, 2, 0.12)), n), /bandwidth/);
  const contaminated = cut(); contaminated.analysis.fill(NaN);
  assert.throws(() => prepareComparison(frames(cut(), contaminated), n), /overlap/);
  const crowded = cut(); crowded.source.fill(1);
  assert.throws(() => prepareComparison(frames(cut(), crowded), n), /background/);
});

test('spectrally mismatched and contaminated pixels are excluded with a boundary guard', () => {
  const a = cut(), b = cut();
  b.analysis[20 * n + 20] = NaN;
  b.pixels[2 * (30 * n + 30)] = -1;
  const result = prepareComparison(frames(a, b), n);
  assert.ok(Number.isNaN(result.frames[0].data[20 * n + 21]));
  assert.ok(Number.isNaN(result.frames[0].data[30 * n + 30]));
  assert.ok(Number.isFinite(result.frames[0].data[10 * n + 10]));
});

test('scan selection excludes unknown and incompatible visits without mixing wavelengths', () => {
  const good = frames(cut(), cut(0, 2.001), cut(0, 2.002));
  const bad = frames(cut(0, 2.05));
  const unknown = { analysisError: true, analysisCuts: [cut()] };
  assert.deepEqual(selectCompatibleFrames([bad[0], ...good, unknown]), good);
});
