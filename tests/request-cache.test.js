import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cachedRequest } from '../js/request-cache.js';

test('cancelling validation does not cancel a shared browser metadata reader', async () => {
  const cache = new Map(), controller = new AbortController();
  let finish, calls = 0, shared;
  const load = signal => { calls++; shared = signal; return new Promise(resolve => { finish = resolve; }); };
  const first = cachedRequest(cache, 'file', load, controller.signal);
  const second = cachedRequest(cache, 'file', load);
  const aborted = assert.rejects(first, { name: 'AbortError' });
  await Promise.resolve();
  controller.abort();
  await aborted;
  assert.equal(shared.aborted, false);
  finish(42);
  assert.equal(await second, 42);
  assert.equal(calls, 1);
});
test('failed shared requests are evicted and already-cancelled callers start no work', async () => {
  const cache = new Map(), controller = new AbortController();
  let calls = 0;
  controller.abort();
  await assert.rejects(cachedRequest(cache, 'file', () => { calls++; }, controller.signal), { name: 'AbortError' });
  assert.equal(calls, 0);
  await assert.rejects(cachedRequest(cache, 'file', () => { calls++; throw new Error('offline'); }), /offline/);
  assert.equal(await cachedRequest(cache, 'file', () => { calls++; return 7; }), 7);
  assert.equal(calls, 2);
});
