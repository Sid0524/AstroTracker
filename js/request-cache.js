// One caller cancelling a shared metadata request must not cancel other readers.
export function withAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => {
      signal.removeEventListener('abort', abort);
      resolve(value);
    }, error => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

export function cachedRequest(cache, key, load, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (!cache.has(key)) {
    const promise = Promise.resolve().then(() => load(AbortSignal.timeout(60000)));
    cache.set(key, promise);
    promise.catch(() => { if (cache.get(key) === promise) cache.delete(key); });
  }
  return withAbort(cache.get(key), signal);
}
