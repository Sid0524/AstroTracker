// Wavelength lookup (WCS-WAVE table) against scipy's bilinear interpolation of the same table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseWaveTable, lookup, waveTable } from '../js/wave.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/wave.json', import.meta.url)));
const table = parseWaveTable(new Uint8Array(Buffer.from(fx.tail, 'base64')));

test('parses the table from the end of a real file', () => {
  assert.equal(table.xs.length, 11);
  assert.equal(table.ys.length, 11);
});

test('wavelength matches reference interpolation to 1e-5 µm', () => {
  fx.pix.forEach(([x, y], i) => {
    const { lam } = lookup(table, x, y);
    assert.ok(Math.abs(lam - fx.lam[i]) < 1e-5, `(${x},${y}) ${lam} vs ${fx.lam[i]}`);
  });

});

test('wavelength cache separates releases but shares collection/version/detector across S3 hosts', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    const bytes = Buffer.from(fx.tail, 'base64');
    return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  });
  const path = 'level2/2025W19_1B/l2b-v27-2026-197/3/example.fits';
  const qr = await waveTable(`https://nasa-irsa-spherex.s3.amazonaws.com/qr2/${path}`);
  const dr = await waveTable(`https://nasa-irsa-spherex.s3.amazonaws.com/dr1/${path}`);
  const otherHost = await waveTable(`https://s3.amazonaws.com/nasa-irsa-spherex/dr1/${path}`);
  assert.equal(calls.length, 2);
  assert.notStrictEqual(qr, dr);
  assert.strictEqual(dr, otherHost);
});
