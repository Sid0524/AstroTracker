import { test } from 'node:test';
import assert from 'node:assert/strict';

const index = {
  tileDeg: 5, mjd0: 60000, rowBytes: 24,
  folders: [], versions: [], tiles: { '18_0': 1 },
};

function search(catalog, type, signal) {
  return type === 'fixed'
    ? catalog.findExposures(0, 0, signal)
    : catalog.findAlongPath([{ ra: 0, dec: 0 }], () => ({ ra: 0, dec: 0 }), signal);
}

for (const type of ['fixed', 'path']) {
  test(`${type} search cancellation does not abort another reader's shared tile`, async t => {
    const catalog = await import(`../js/catalog.js?tile-cancellation-${type}`);
    const controller = new AbortController();
    let finishTile, tileSignal, requests = 0;
    let tileStarted;
    const started = new Promise(resolve => { tileStarted = resolve; });
    t.mock.method(globalThis, 'fetch', (url, options) => {
      if (url === 'data/index.json') return Promise.resolve({ ok: true, json: async () => index });
      requests++;
      tileSignal = options.signal;
      return new Promise((resolve, reject) => {
        finishTile = () => resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) });
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        tileStarted();
      });
    });
    const first = search(catalog, type, controller.signal);
    await started;
    const other = search(catalog, type === 'fixed' ? 'path' : 'fixed');
    const cancelled = assert.rejects(first, { name: 'AbortError' });
    controller.abort();
    await cancelled;
    assert.equal(tileSignal.aborted, false);
    finishTile();
    assert.deepEqual(await other, []);
    assert.deepEqual(await search(catalog, type), []);
    assert.equal(requests, 1);
  });

  test(`${type} search can cancel while waiting for the shared index`, async t => {
    const catalog = await import(`../js/catalog.js?index-cancellation-${type}`);
    const controller = new AbortController();
    let finishIndex, requests = 0;
    t.mock.method(globalThis, 'fetch', () => {
      requests++;
      return new Promise(resolve => {
        finishIndex = () => resolve({ ok: true, json: async () => ({ ...index, tiles: {} }) });
      });
    });
    const first = search(catalog, type, controller.signal);
    const other = search(catalog, type === 'fixed' ? 'path' : 'fixed');
    const cancelled = assert.rejects(first, { name: 'AbortError' });
    controller.abort();
    await cancelled;
    finishIndex();
    assert.deepEqual(await other, []);
    assert.equal(requests, 1);
  });
}

test('failed shared tiles are evicted so a later catalog search retries', async t => {
  const catalog = await import('../js/catalog.js?tile-retry');
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    if (url === 'data/index.json') return { ok: true, json: async () => index };
    requests++;
    if (requests === 1) throw new Error('offline');
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
  });
  await assert.rejects(catalog.findExposures(0, 0), /offline/);
  assert.deepEqual(await catalog.findExposures(0, 0), []);
  assert.equal(requests, 2);
});
