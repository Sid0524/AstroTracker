import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deduplicateExposures, exposureUrl, findAlongPath, findExposures, summarizeIndex,
} from '../js/catalog.js';

test('DR1 and Quick Release rows resolve through their collection-specific level-2 paths', () => {
  const expected = 'level2/2025W19_1B/l2b-v27-2026-197/3/level2_2025W19_1B_0116_1D3_spx_l2b-v27-2026-197.fits';
  for (const release of ['dr1', 'qr2', 'qr3']) {
    const url = exposureUrl(release, '2025W19_1B', 'l2b-v27-2026-197', '2025W19_1B_0116_1', 3);
    assert.ok(url.endsWith(`/${release}/${expected}`));
  }
});

test('index summary derives legacy collection coverage and never invents freshness', () => {
  const summary = summarizeIndex({
    folders: ['qr2/2025W19_1B', 'dr1/2025W19_1B'],
    versions: ['v1'],
  }, Date.parse('2026-11-15T00:00:00Z'));
  assert.deepEqual(summary.collections, [
    { name: 'spherex_qr2', folderCount: 1 },
    { name: 'spherex_dr1', folderCount: 1 },
  ]);
  assert.equal(summary.folderCount, 2);
  assert.equal(summary.versionCount, 1);
  assert.deepEqual(summary.freshness, { status: 'unknown', updatedAt: null, ageMs: null });
  assert.equal(summary.refreshProvenance, null);
});

test('index summary reports stored update and provenance when available', () => {
  const summary = summarizeIndex({
    updated: '2026-11-14T00:00:00Z',
    indexedCollections: ['spherex_dr1'],
    refreshProvenance: { mode: 'incremental' },
    folders: ['dr1/2025W19_1B'],
    versions: [],
  }, Date.parse('2026-11-15T00:00:00Z'));
  assert.deepEqual(summary.freshness, {
    status: 'known',
    updatedAt: '2026-11-14T00:00:00Z',
    ageMs: 86400000,
  });
  assert.equal(summary.collections[0].name, 'spherex_dr1');
  assert.deepEqual(summary.refreshProvenance, { mode: 'incremental' });
});

test('physical exposure deduplication prefers DR then numbered releases independent of input order', () => {
  const record = (release, id = '2025W19_1B_0116_1', detector = 3) => ({
    id, detector, mjd: 60800,
    url: exposureUrl(release, '2025W19_1B', 'l2b-v27-2026-197', id, detector),
  });
  const rows = [record('qr3'), record('dr1'), record('qr12'), record('dr2')];
  const expected = rows[3];
  assert.deepEqual(deduplicateExposures(rows), [expected]);
  assert.deepEqual(deduplicateExposures([...rows].reverse()), [expected]);
  assert.deepEqual(deduplicateExposures([rows[0], rows[2]]), [rows[2]]);
  assert.equal(deduplicateExposures([...rows, record('dr1', rows[0].id, 6), record('qr3', 'another')]).length, 3);
  const tied = { ...expected, url: expected.url.replace('l2b-v27', 'l2b-v28') };
  assert.deepEqual(deduplicateExposures([tied, expected]), deduplicateExposures([expected, tied]));
});

test('fixed and path searches both return one preferred release per exposure and detector', async t => {
  const index = {
    tileDeg: 5, mjd0: 60000, rowBytes: 24,
    folders: ['qr2/2025W19_1B', 'dr1/2025W19_1B', 'qr3/2025W19_1B'],
    versions: ['l2b-v27-2026-197'], tiles: { '18_0': 4 }, total: 4,
  };
  const buffer = new ArrayBuffer(4 * 24);
  const view = new DataView(buffer);
  for (const [i, folder, detector] of [[0, 0, 3], [1, 1, 3], [2, 2, 3], [3, 0, 6]]) {
    const offset = i * 24;
    view.setFloat32(offset, 0, true);
    view.setFloat32(offset + 4, 0, true);
    view.setFloat32(offset + 8, 800, true);
    view.setUint8(offset + 14, detector);
    view.setUint8(offset + 15, 1);
    view.setUint16(offset + 16, folder, true);
    view.setUint16(offset + 18, 116, true);
  }
  t.mock.method(globalThis, 'fetch', async url => url === 'data/index.json'
    ? { ok: true, json: async () => index }
    : { ok: true, arrayBuffer: async () => buffer });
  const fixed = await findExposures(0, 0);
  const path = await findAlongPath([{ ra: 0, dec: 0 }], () => ({ ra: 0, dec: 0 }));
  for (const results of [fixed, path]) {
    assert.equal(results.length, 2);
    assert.match(results.find(row => row.detector === 3).url, /\/dr1\/level2\//);
    assert.match(results.find(row => row.detector === 6).url, /\/qr2\/level2\//);
  }
  assert.ok(path.every(row => row.obj.ra === 0 && row.obj.dec === 0));
  assert.equal(index.total, 4);
});
