import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wavelengthWindow, inWavelengthWindow, countFlagBits, qualitySummary, encodeSettings, decodeSettings, csv, frameKey, candidateCSV } from '../js/observations.js';

const cut = lam => ({ pix: [1, 1], wave: { xs: [1, 3], ys: [1, 3], vals: Array.from({ length: 4 }, () => [lam, 0.05]).flat() } });
test('wavelength windows require metadata in every exposure and at the selected point', () => {
  const window = wavelengthWindow(1, 1.1);
  assert.ok(inWavelengthWindow({ analysisCuts: [cut(1.05), cut(1.08)] }, window));
  assert.equal(inWavelengthWindow({ analysisCuts: [cut(1.05), cut(1.2)] }, window), false);
  assert.equal(inWavelengthWindow({ analysisCuts: [{}] }, window), false);
  const c = cut(1.05); c.pixels = new Float32Array([10, 10]);
  assert.equal(inWavelengthWindow({ analysisCuts: [c] }, window, [0, 0], 1), false);
  assert.throws(() => wavelengthWindow(2, 1), /minimum/);
  assert.throws(() => wavelengthWindow(NaN, 1), /window/);
});
test('quality counts include SOURCE and unsigned unknown bits without calling missing flags clean', () => {
  assert.equal(countFlagBits(new Uint32Array([1 << 21, 0x80000000, (1 << 21) | (1 << 22)]))[21], 2);
  assert.equal(countFlagBits(new Uint32Array([0x80000000]))[31], 1);
  assert.equal(qualitySummary({ analysisCuts: [{}] }, 1).known, false);
  const summary = qualitySummary({ analysisCuts: [{ analysis: [1, NaN, 2, 3], flagCounts: Array(32).fill(0) }] }, 2);
  assert.equal(summary.valid, 3);
});
test('shared settings retain exact exposure identities and reject malformed values', () => {
  const original = { group: false, mask: true, invert: true, crosshair: false, colourFix: false, asteroids: false,
    qualityMask: true, stretch: 'asinh', cmap: 'gray', contrast: 0.998, fps: 4, maxFrames: 80, astMag: 20,
    context: 'none', window: { min: 1, max: 1.1 }, epochA: 'first,second', epochB: 'third', epoch: 'third', probe: [12, 14] };
  assert.deepEqual(decodeSettings(encodeSettings(original)), original);
  assert.equal(frameKey({ exposures: [{ id: 'a' }, { id: 'b' }] }), 'a,b');
  assert.throws(() => decodeSettings(new URLSearchParams('mask=yes')), /Invalid/);
  assert.throws(() => decodeSettings(new URLSearchParams('fps=0')), /Invalid/);
  assert.throws(() => decodeSettings(new URLSearchParams('waveMin=1')), /incomplete/);
  assert.throws(() => decodeSettings(new URLSearchParams('probe=240,3')), /probe/);
});
test('CSV preserves commas, quotes, coordinates and neutralizes formula names', () => {
  assert.equal(csv([['name', 'dec'], ['=formula', -56], ['a,"b"', null]]), 'name,dec\r\n\'=formula,-56\r\n"a,""b""",\r\n');
});
test('exposure identity includes release and processing version but not S3 hostname style', () => {
  const frame = url => ({ exposures: [{ id: 'exposure', url }] });
  const a = frame('https://nasa-irsa-spherex.s3.amazonaws.com/qr3/level2/folder/v1/1/image.fits');
  const b = frame('https://s3.amazonaws.com/nasa-irsa-spherex/qr3/level2/folder/v1/1/image.fits');
  const c = frame('https://nasa-irsa-spherex.s3.amazonaws.com/dr1/level2/folder/v2/1/image.fits');
  assert.equal(frameKey(a), frameKey(b));
  assert.notEqual(frameKey(a), frameKey(c));
});
test('candidate export retains all rows and distinguishes catalog failures from negative matches', () => {
  const frameRef = { date: new Date('2026-01-01T00:00:00Z'), lam: 1.05, exposures: [{ id: 'a', url: 'https://example.test/qr3/level2/a.fits' }] };
  const candidate = { frameRef, kind: 'new', x: 1, y: 2, snr: 7, seenIn: 2 };
  const text = candidateCSV([candidate, { ...candidate, known: null }, { ...candidate, known: { name: 'Ceres' }, glitch: true }],
    { band: 1, positionAt: () => [269.4, -56.7], viewURL: 'https://example.test/#view=diff' });
  const lines = text.trim().split('\r\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /exploratory_score_not_significance/);
  assert.match(lines[1], /unavailable or pending/);
  assert.match(lines[2], /no match/);
  assert.match(lines[3], /Ceres,matched,true/);
  assert.match(lines[1], /269.4,-56.7/);
  assert.match(lines[1], /https:\/\/example.test\/qr3\/level2\/a.fits/);
});
