// Person 1 data reliability in SpaceLapse: release scope, unknown vs empty
// coverage, and partial index failures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  releaseOf, groupCoverage, nearestIndex, surveyWindows, noCoverageMessage, partialCoverageMessage, coverageSummary,
} from '../js/coverage.js';
import { exposureUrl, summarizeIndex } from '../js/catalog.js';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const exp = (mjd, detector = 1, release = 'qr2') => ({
  id: `x${mjd}`, detector, mjd, date: new Date((mjd - 40587) * 86400000), release,
  url: exposureUrl(release, '2025W19_1B', 'v1', `x${mjd}`, detector),
});
const summary = (folders, updated = '2026-11-10T14:52:01Z') => summarizeIndex({ folders, versions: [], updated }, NOW);

test('release comes from the record, else from its S3 path', () => {
  assert.equal(releaseOf({ release: 'dr1' }), 'dr1');
  assert.equal(releaseOf({ url: exposureUrl('qr3', 'f', 'v', 'i', 2) }), 'qr3');
  assert.equal(releaseOf({ url: 'https://example/other.fits' }), 'unknown');
  assert.equal(releaseOf({}), 'unknown');
});

test('empty search names the searched releases and index date, and flags missing DR1', () => {
  const text = noCoverageMessage(summary(['qr2/a', 'qr3/b']));
  assert.match(text, /^No SPHEREx exposures of this position in the index \(searched QR2, QR3; index updated 2026-11-10, 3 days ago\)\./);
  assert.match(text, /DR1 is not indexed yet/);
  assert.doesNotMatch(text, /hasn.t released/, 'never claims SPHEREx has no images at all');
});

test('once DR1 is indexed the DR1 caveat disappears', () => {
  assert.doesNotMatch(noCoverageMessage(summary(['dr1/a', 'qr3/b'])), /DR1 is not indexed/);
});

test('unknown index freshness or a missing index is stated, not hidden', () => {
  assert.match(noCoverageMessage(summarizeIndex({ folders: ['qr3/a'], versions: [] }, NOW)), /index update time unknown/);
  const text = noCoverageMessage(null);
  assert.match(text, /searched unknown releases; index update time unknown/);
  assert.doesNotMatch(text, /DR1 is not indexed/);
});

test('a one-day-old index uses singular wording', () => {
  assert.match(noCoverageMessage(summarizeIndex({ folders: ['qr3/a'], versions: [], updated: '2026-11-13T00:00:00Z' }, NOW)), /1 day ago/);
});

test('partial tile failure says coverage is incomplete', () => {
  assert.equal(partialCoverageMessage(1, 3),
    'Coverage incomplete: 1 of 3 index tiles failed to load, so some dates may be missing. Search again to retry.');
  assert.match(partialCoverageMessage(1, 1), /1 of 1 index tile failed/);
});

test('coverage summary counts exposures, dates, windows and releases', () => {
  const list = [exp(60900), exp(60900.3), exp(60910, 2), exp(61100, 1, 'qr3')];
  assert.equal(coverageSummary(list, summary(['qr2/a', 'qr3/b'])),
    '4 exposures on 3 UTC dates in 2 survey windows (QR2 3, QR3 1). Searched QR2, QR3; index updated 2026-11-10, 3 days ago. DR1 is not indexed yet, so reprocessed images may exist.');
  assert.match(coverageSummary([exp(60900, 1, 'dr1')], summary(['dr1/a'])), /^1 exposure on 1 UTC date in 1 survey window \(DR1 1\)\./);
});

test('groups are one per detector, UTC day and release, in time order', () => {
  const groups = groupCoverage([exp(60910, 2), exp(60900.6), exp(60900.2), exp(60900.2, 1, 'qr3')]);
  assert.deepEqual(groups.map(g => [g.detector, g.day, g.release, g.count]), [
    [1, '2025-08-13', 'qr2', 2], [1, '2025-08-13', 'qr3', 1], [2, '2025-08-23', 'qr2', 1],
  ]);
  assert.equal(groups[0].mjd, 60900.2, 'earliest exposure time');
  assert.equal(groupCoverage([{ ...exp(60900), date: undefined }])[0].day, '2025-08-13', 'date derived from MJD');
});

test('survey windows split on gaps longer than 30 days', () => {
  assert.deepEqual(surveyWindows([exp(1), exp(30), exp(61), exp(300)]).map(w => w.count), [2, 1, 1]);
  assert.deepEqual(surveyWindows([]), []);
});

// --- catalog: partial and failed index tiles -------------------------------

function tileIndex() {
  return { tileDeg: 5, mjd0: 60000, rowBytes: 24, folders: ['qr3/2025W19_1B'], versions: ['v1'], tiles: { '18_0': 1, '18_71': 1 }, total: 2 };
}
function oneRow() {
  const buffer = new ArrayBuffer(24), v = new DataView(buffer);
  v.setFloat32(8, 800, true); v.setUint8(14, 3); v.setUint8(15, 1); v.setUint16(18, 116, true);
  return buffer;
}

test('one failed tile keeps the other results and reports the failure', async t => {
  const { findExposuresDetailed } = await import('../js/catalog.js?partial');
  t.mock.method(globalThis, 'fetch', async url => {
    if (url === 'data/index.json') return { ok: true, json: async () => tileIndex() };
    if (url.endsWith('18_71.bin')) return { ok: false, status: 503 };
    return { ok: true, arrayBuffer: async () => oneRow() };
  });
  const found = await findExposuresDetailed(0, 0);
  assert.equal(found.tiles, 2);
  assert.deepEqual(found.failedTiles, ['18_71']);
  assert.equal(found.exposures.length, 1);
  assert.equal(found.exposures[0].release, 'qr3', 'records carry their release');
});

test('when every tile fails the search fails, says coverage is unknown and keeps the cause', async t => {
  const { findExposuresDetailed } = await import('../js/catalog.js?allfail');
  t.mock.method(globalThis, 'fetch', async url => (url === 'data/index.json'
    ? { ok: true, json: async () => tileIndex() } : { ok: false, status: 404 }));
  await assert.rejects(findExposuresDetailed(0, 0), /HTTP 404\), so coverage is unknown/);
});

test('a position with no index tiles is a clean empty result, not a failure', async t => {
  const { findExposuresDetailed } = await import('../js/catalog.js?notiles');
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ ...tileIndex(), tiles: {} }) }));
  assert.deepEqual(await findExposuresDetailed(0, 0), { exposures: [], tiles: 0, failedTiles: [] });
});

test('cancelling a search still cancels, rather than reporting a tile failure', async t => {
  const { findExposuresDetailed } = await import('../js/catalog.js?abort');
  const abort = new AbortController();
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (url === 'data/index.json') return { ok: true, json: async () => tileIndex() };
    abort.abort();
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  });
  await assert.rejects(findExposuresDetailed(0, 0, abort.signal), { name: 'AbortError' });
});

test('UI: a coverage click jumps to the loaded frame closest in time, earliest on ties', () => {
  const frames = [{ mjd: 100 }, { mjd: 110 }, { mjd: 130 }];
  assert.equal(nearestIndex(frames, 112), 1);
  assert.equal(nearestIndex(frames, 500), 2);
  assert.equal(nearestIndex(frames, 120), 1, 'tie between 110 and 130 keeps the earlier frame');
  assert.equal(nearestIndex([], 100), -1, 'nothing loaded yet: no jump');
});

// --- downloads and moving objects: missing data vs could not confirm --------
import { noCutoutsMessage, partialDownloadMessage } from '../js/coverage.js';

test('P1: when no cutouts load because downloads failed, say it is not confirmed missing data', () => {
  const text = noCutoutsMessage([{ failed: true }, { failed: true }, { offImage: true }]);
  assert.match(text, /^2 of 3 visits could not be downloaded/);
  assert.match(text, /not confirmed as missing data/);
});

test('P1: when every visit is genuinely off the image, report no usable cutouts', () => {
  assert.match(noCutoutsMessage([{ offImage: true }, {}]), /^No usable cutouts: the target is outside the usable image area/);
});

test('P1: visits with nothing downloaded are announced as missing from this view', () => {
  assert.equal(partialDownloadMessage([{ failed: true, status: 'error' }, { status: 'ok' }, { status: 'ok' }]),
    '1 of 3 visits could not be downloaded; it is missing from this view, not confirmed missing from the archive. Search again to retry.');
  assert.match(partialDownloadMessage([{ failed: true, status: 'error' }, { failed: true, status: 'error' }, { status: 'ok' }]),
    /^2 of 3 visits could not be downloaded; they are missing/);
});

test('P1: visits shown with some exposures missing are not called missing', () => {
  const text = partialDownloadMessage([{ failed: true, status: 'ok' }, { status: 'ok' }]);
  assert.equal(text, '1 of 2 visits is shown with fewer exposures because some downloads failed. Search again to retry.');
  assert.match(partialDownloadMessage([{ failed: true, status: 'ok' }, { failed: true, status: 'ok' }, {}]), /^2 of 3 visits are shown with fewer exposures/);
  assert.match(partialDownloadMessage([{ failed: true, status: 'error' }, { failed: true, status: 'ok' }, {}]),
    /^1 of 3 visits could not be downloaded; it is missing.*1 more is shown with fewer exposures/);
});

test('P1: no failed downloads means no message', () => {
  assert.equal(partialDownloadMessage([{ status: 'ok' }, { status: 'off' }]), '');
});

test('P1: the empty-coverage message can name a moving object instead of a position', () => {
  assert.match(noCoverageMessage(summary(['qr3/a']), '3I/ATLAS along its path'), /^No SPHEREx exposures of 3I\/ATLAS along its path in the index/);
});

test('P1: a path search keeps results from good tiles and reports failed ones', async t => {
  const { findAlongPathDetailed } = await import('../js/catalog.js?path-partial');
  t.mock.method(globalThis, 'fetch', async url => {
    if (url === 'data/index.json') return { ok: true, json: async () => tileIndex() };
    if (url.endsWith('18_71.bin')) return { ok: false, status: 503 };
    return { ok: true, arrayBuffer: async () => oneRow() };
  });
  const found = await findAlongPathDetailed([{ ra: 0, dec: 0 }], () => ({ ra: 0, dec: 0 }));
  assert.deepEqual(found.failedTiles, ['18_71']);
  assert.equal(found.tiles, 2);
  assert.equal(found.exposures.length, 1);
});

test('P1: a path search with every tile failing says coverage is unknown', async t => {
  const { findAlongPathDetailed } = await import('../js/catalog.js?path-allfail');
  t.mock.method(globalThis, 'fetch', async url => (url === 'data/index.json'
    ? { ok: true, json: async () => tileIndex() } : { ok: false, status: 500 }));
  await assert.rejects(findAlongPathDetailed([{ ra: 0, dec: 0 }], () => ({ ra: 0, dec: 0 })), /coverage is unknown/);
});

test('P1: cancelling a path search still cancels', async t => {
  const { findAlongPathDetailed } = await import('../js/catalog.js?path-abort');
  t.mock.method(globalThis, 'fetch', async url => {
    if (url === 'data/index.json') return { ok: true, json: async () => tileIndex() };
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  });
  await assert.rejects(findAlongPathDetailed([{ ra: 0, dec: 0 }], () => ({ ra: 0, dec: 0 })), { name: 'AbortError' });
});
