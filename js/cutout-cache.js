// In-memory LRU cache of finished cutouts, so revisiting a detector or date
// does not download the same pixels again.
import { withAbort } from './request-cache.js';

export const CUTOUT_CACHE_BYTES = 150 * 1024 * 1024;

export function cutoutKey(exposure, ra, dec, size, mask, scale) {
  return `${exposure.url}|${ra.toFixed(7)}|${dec.toFixed(7)}|${size}|${mask ? 1 : 0}|${scale}`;
}

const sizeOf = c => ['data', 'analysis', 'source', 'pixels'].reduce((n, k) => n + (c?.[k]?.byteLength || 0), 0);

// get(key, build, signal): shares one build per key; failures and results with a
// quality error are not kept; callers get a shallow copy (arrays are shared, read-only).
export function createCutoutCache({ maxBytes = CUTOUT_CACHE_BYTES } = {}) {
  const entries = new Map(); // key -> { promise, bytes }
  let total = 0;
  const drop = key => { const e = entries.get(key); if (e) { total -= e.bytes; entries.delete(key); } };

  function get(key, build, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    let entry = entries.get(key);
    if (entry) {
      entries.delete(key);
      entries.set(key, entry); // most recently used
    } else {
      // The shared build is not tied to one caller's signal: switching away lets it finish.
      entry = { promise: Promise.resolve().then(() => build(AbortSignal.timeout(60000))), bytes: 0 };
      entries.set(key, entry);
      entry.promise.then(c => {
        if (entries.get(key) !== entry) return;
        if (c?.qualityError) return drop(key);
        entry.bytes = sizeOf(c);
        total += entry.bytes;
        if (entry.bytes > maxBytes) return drop(key);
        for (const k of entries.keys()) {
          if (total <= maxBytes) break;
          if (k !== key) drop(k);
        }
      }, () => { if (entries.get(key) === entry) drop(key); });
    }
    return withAbort(entry.promise, signal).then(c => ({ ...c }));
  }

  return { get, keys: () => [...entries.keys()], bytes: () => total };
}
