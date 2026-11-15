// Revisiting a detector reuses finished cutouts instead of downloading them again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCutoutCache, cutoutKey } from '../js/cutout-cache.js';

const cut = (n = 4) => ({ data: new Float32Array(n), valid: 1 });

test('UI: a finished cutout is reused, not downloaded again', async () => {
  const cache = createCutoutCache();
  let builds = 0;
  const build = async () => { builds++; return cut(); };
  const a = await cache.get('k', build);
  const b = await cache.get('k', build);
  assert.equal(builds, 1);
  assert.equal(a.data, b.data, 'pixel arrays are shared');
  assert.notEqual(a, b, 'each caller gets its own object, so app-added fields do not leak');
  a.waveError = 'x';
  assert.equal((await cache.get('k', build)).waveError, undefined);
});

test('UI: two requests for the same cutout share one download', async () => {
  const cache = createCutoutCache();
  let builds = 0, release;
  const build = () => { builds++; return new Promise(r => { release = () => r(cut()); }); };
  const both = Promise.all([cache.get('k', build), cache.get('k', build)]);
  await new Promise(r => setImmediate(r)); // let the shared download start
  release();
  await both;
  assert.equal(builds, 1);
});

test('P1: a failed download is not cached, so the next attempt retries', async () => {
  const cache = createCutoutCache();
  let builds = 0;
  const flaky = async () => { builds++; if (builds === 1) throw new Error('S3 503'); return cut(); };
  await assert.rejects(cache.get('k', flaky), /S3 503/);
  assert.equal((await cache.get('k', flaky)).valid, 1);
  assert.equal(builds, 2);
});

test('P1: a cutout whose quality layer failed is not cached, so quality is retried', async () => {
  const cache = createCutoutCache();
  let builds = 0;
  const build = async () => { builds++; return builds === 1 ? { ...cut(), qualityError: 'FLAGS timeout' } : cut(); };
  assert.equal((await cache.get('k', build)).qualityError, 'FLAGS timeout');
  assert.equal((await cache.get('k', build)).qualityError, undefined);
  assert.equal(builds, 2);
});

test('UI: switching away mid-download cancels the caller, not the shared download', async () => {
  const cache = createCutoutCache();
  let release, builds = 0;
  const build = () => { builds++; return new Promise(r => { release = () => r(cut()); }); };
  const abort = new AbortController();
  const first = cache.get('k', build, abort.signal);
  await new Promise(r => setImmediate(r));
  abort.abort(new DOMException('switched detector', 'AbortError'));
  await assert.rejects(first, { name: 'AbortError' });
  release();
  assert.equal((await cache.get('k', build)).valid, 1, 'the finished download is reused');
  assert.equal(builds, 1);
  await assert.rejects(cache.get('k', build, AbortSignal.abort()), { name: 'AbortError' });
});

test('memory stays bounded: least recently used cutouts are evicted by size', async () => {
  const cache = createCutoutCache({ maxBytes: 3 * 16 }); // room for three 4-float cutouts
  for (const k of ['a', 'b', 'c']) await cache.get(k, async () => cut());
  await cache.get('a', async () => cut());          // touch a
  await cache.get('d', async () => cut());          // evicts b, the least recently used
  assert.deepEqual(cache.keys(), ['c', 'a', 'd']);
  assert.equal(cache.bytes(), 48);
  await cache.get('huge', async () => cut(100));    // larger than the budget: returned, not kept
  assert.ok(!cache.keys().includes('huge'));
});

test('off-image results are cached too (they are deterministic)', async () => {
  const cache = createCutoutCache();
  let builds = 0;
  for (let i = 0; i < 2; i++) assert.deepEqual(await cache.get('k', async () => { builds++; return { offImage: true }; }), { offImage: true });
  assert.equal(builds, 1);
});

test('the cache key separates exposure, centre, size, masking and scale', () => {
  const e = { url: 'https://s3/x.fits' };
  const k = cutoutKey(e, 10.123456789, -5.5, 96, true, 6.15);
  assert.equal(k, 'https://s3/x.fits|10.1234568|-5.5000000|96|1|6.15');
  assert.notEqual(k, cutoutKey(e, 10.123456789, -5.5, 96, false, 6.15));
  assert.notEqual(k, cutoutKey(e, 10.123456789, -5.5, 160, true, 6.15));
});
