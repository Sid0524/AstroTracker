// Orbit lookup: an unknown object is "not found"; an unreachable orbit service is "could not check".
import { test } from 'node:test';
import assert from 'node:assert/strict';

const featuredEmpty = { ok: true, json: async () => ({ objects: [] }) };

test('O1/P1: an unknown comet or asteroid is reported as not found', async t => {
  const { ephemeris } = await import('../js/ephem.js?unknown');
  t.mock.method(globalThis, 'fetch', async url => (url.startsWith('data/') ? featuredEmpty
    : { ok: true, json: async () => ({ message: 'unknown body' }) }));
  await assert.rejects(ephemeris('Planet X'), /^Error: Couldn't find a comet or asteroid called/);
});

test('P1: an unreachable orbit service is "could not check", never "not found"', async t => {
  const { ephemeris } = await import('../js/ephem.js?offline');
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.startsWith('data/')) return featuredEmpty;
    throw new TypeError('Failed to fetch');
  });
  await assert.rejects(ephemeris('Ceres'), e => /could not be checked/.test(e.message) && !/Couldn't find/.test(e.message));
});

test('P1: an orbit-service error page is "could not check"', async t => {
  const { ephemeris } = await import('../js/ephem.js?http502');
  t.mock.method(globalThis, 'fetch', async url => (url.startsWith('data/') ? featuredEmpty
    : { ok: false, status: 502, json: async () => { throw new SyntaxError('not json'); } }));
  await assert.rejects(ephemeris('Ceres'), /could not be checked/);
});

test('cancelling an orbit lookup still cancels', async t => {
  const { ephemeris } = await import('../js/ephem.js?abort');
  const abort = new AbortController();
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.startsWith('data/')) return featuredEmpty;
    abort.abort();
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  });
  await assert.rejects(ephemeris('Ceres', abort.signal), { name: 'AbortError' });
});
