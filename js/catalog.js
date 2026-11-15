// Find SPHEREx exposures covering a sky position using the static tile index
// built by tools/build_index.py (IRSA's own search API doesn't allow browser CORS).

import { cachedRequest, withAbort } from './request-cache.js';

// The same public bucket answers on several hostnames. S3 speaks HTTP/1.1, where
// browsers allow only ~6 connections per host, so spreading files across hosts
// lets many more range requests run at once. A file always maps to the same host.
const S3_HOSTS = [
  'https://nasa-irsa-spherex.s3.amazonaws.com/',
  'https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/',
  'https://s3.amazonaws.com/nasa-irsa-spherex/',
  'https://s3.us-east-1.amazonaws.com/nasa-irsa-spherex/',
];

function s3Base(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return S3_HOSTS[Math.abs(h) % S3_HOSTS.length];
}
const HALF_SIDE = 1.74;   // detector half-width in degrees (2040 px × 6.15″ / 2)
const SEARCH_R = 2.5;     // max centre distance for a detector to contain the target

export const DETECTORS = {
  1: { name: 'D1', range: '0.75–1.09 µm', color: '#7aa2ff' },
  2: { name: 'D2', range: '1.10–1.62 µm', color: '#6fd3ff' },
  3: { name: 'D3', range: '1.63–2.41 µm', color: '#77e0b5' },
  4: { name: 'D4', range: '2.42–3.82 µm', color: '#f2d36b' },
  5: { name: 'D5', range: '3.83–4.41 µm', color: '#ffa25c' },
  6: { name: 'D6', range: '4.42–5.00 µm', color: '#ff6b6b' },
};

let indexPromise = null;
export function loadIndex() {
  indexPromise ??= fetch('data/index.json').then(r => {
    if (!r.ok) throw new Error('Could not load the SPHEREx image index, so coverage is unknown. Search again to retry.');
    return r.json();
  });
  indexPromise.catch(() => { indexPromise = null; });
  return indexPromise;
}

// Summarize only metadata actually present in the static index. Older indexes
// predate indexedCollections/refreshProvenance, so derive collection coverage
// from their stored folder keys and report refresh timing as unknown if absent.
export function summarizeIndex(index, now = Date.now()) {
  const folders = Array.isArray(index?.folders) ? index.folders : [];
  const counts = new Map();
  for (const folder of folders) {
    const release = typeof folder === 'string' ? folder.split('/')[0] : '';
    if (release) counts.set(release, (counts.get(release) || 0) + 1);
  }
  const collections = Array.isArray(index?.indexedCollections)
    ? [...new Set(index.indexedCollections.filter(value => typeof value === 'string'))]
    : [...counts.keys()].map(release => `spherex_${release}`);
  const updatedAt = typeof index?.updated === 'string' && Number.isFinite(Date.parse(index.updated))
    ? index.updated
    : null;
  const timestamp = updatedAt === null ? null : Date.parse(updatedAt);
  return {
    collections: collections.map(name => ({
      name,
      folderCount: counts.get(name.replace(/^spherex_/, '')) || 0,
    })),
    folderCount: folders.length,
    versionCount: Array.isArray(index?.versions) ? index.versions.length : 0,
    freshness: {
      status: timestamp === null ? 'unknown' : 'known',
      updatedAt,
      ageMs: timestamp === null ? null : Number(now) - timestamp,
    },
    refreshProvenance: index?.refreshProvenance ?? null,
  };
}

const tileCache = new Map();
function loadTile(key, signal) {
  return cachedRequest(tileCache, key, sharedSignal =>
    fetch(`data/tiles/${key}.bin`, { signal: sharedSignal }).then(r => {
      if (!r.ok) throw new Error(`tile ${key}: HTTP ${r.status}`);
      return r.arrayBuffer();
    }), signal);
}

// Must mirror tile_key() in tools/build_index.py.
function bandInfo(band, deg) {
  const lo = -90 + band * deg, hi = lo + deg;
  const edge = lo < 0 && hi > 0 ? 0 : Math.min(Math.abs(lo), Math.abs(hi));
  return Math.max(1, Math.ceil((360 * Math.cos((edge * Math.PI) / 180)) / deg));
}

export function tilesNear(ra, dec, r, deg) {
  const keys = new Set();
  const nBands = Math.round(180 / deg);
  const b0 = Math.max(0, Math.floor((dec - r + 90) / deg));
  const b1 = Math.min(nBands - 1, Math.floor((dec + r + 90) / deg));
  const maxAbsDec = Math.min(90, Math.abs(dec) + r);
  const dra = maxAbsDec >= 89.9 ? 360 : r / Math.cos((maxAbsDec * Math.PI) / 180);
  for (let b = b0; b <= b1; b++) {
    const n = bandInfo(b, deg);
    if (dra >= 180) { for (let i = 0; i < n; i++) keys.add(`${b}_${i}`); continue; }
    const i0 = Math.floor((((ra - dra) % 360 + 360) % 360) / 360 * n);
    const span = Math.ceil((2 * dra) / 360 * n) + 1;
    for (let k = 0; k <= span; k++) keys.add(`${b}_${(i0 + k) % n}`);
  }
  return [...keys];
}

const D2R = Math.PI / 180;

function project(ra0, dec0, ra, dec) {
  ra0 *= D2R; dec0 *= D2R; ra *= D2R; dec *= D2R;
  const c = Math.sin(dec0) * Math.sin(dec) + Math.cos(dec0) * Math.cos(dec) * Math.cos(ra - ra0);
  if (c <= 0) return null;
  return [
    (Math.cos(dec) * Math.sin(ra - ra0)) / c / D2R,
    (Math.cos(dec0) * Math.sin(dec) - Math.sin(dec0) * Math.cos(dec) * Math.cos(ra - ra0)) / c / D2R,
  ];
}

export function mjdToDate(mjd) {
  return new Date((mjd - 40587) * 86400000);
}

export function exposureUrl(collection, folder, version, id, detector) {
  return `${s3Base(id + detector)}${collection}/level2/${folder}/${version}/${detector}/level2_${id}D${detector}_spx_${version}.fits`;
}

function releasePreference(exposure) {
  const match = exposure.url.match(/\/(dr|qr)(\d+)\/level2\//);
  return match ? [match[1] === 'dr' ? 2 : 1, Number(match[2])] : [0, 0];
}

// Keep raw index records unchanged; searches represent each physical detector
// exposure once, preferring reprocessed DR products over their QR counterparts.
export function deduplicateExposures(exposures) {
  const unique = new Map();
  for (const exposure of exposures) {
    const key = `${exposure.id}/${exposure.detector}`;
    const previous = unique.get(key);
    if (!previous) {
      unique.set(key, exposure);
      continue;
    }
    const rank = releasePreference(exposure), previousRank = releasePreference(previous);
    if (rank[0] > previousRank[0]
      || (rank[0] === previousRank[0] && rank[1] > previousRank[1])
      || (rank[0] === previousRank[0] && rank[1] === previousRank[1] && exposure.url < previous.url)) {
      unique.set(key, exposure);
    }
  }
  return [...unique.values()].sort((a, b) => a.mjd - b.mjd
    || a.id.localeCompare(b.id) || a.detector - b.detector);
}

// Decode one tile row into an exposure record.
function decodeRow(v, o, index) {
  const det = v.getUint8(o + 14), sub = v.getUint8(o + 15);
  const [coll, folder] = index.folders[v.getUint16(o + 16, true)].split('/');
  const seq = String(v.getUint16(o + 18, true)).padStart(4, '0');
  const ver = index.versions[v.getUint16(o + 20, true)];
  const id = `${folder}_${seq}_${sub}`;
  const mjd = v.getFloat32(o + 8, true) + index.mjd0;
  return {
    id,
    detector: det,
    mjd,
    date: mjdToDate(mjd),
    release: coll,
    url: exposureUrl(coll, folder, ver, id, det),
  };
}

// Is (ra, dec) inside the detector footprint stored at row offset o? Returns
// the fractional distance to the edge (0 = centre, 1 = edge) or null.
function contains(v, o, ra, dec) {
  const p = project(v.getFloat32(o, true), v.getFloat32(o + 4, true), ra, dec);
  if (!p || Math.hypot(p[0], p[1]) > SEARCH_R) return null;
  const pa = (v.getInt16(o + 12, true) / 100) * D2R;
  const u = p[0] * Math.cos(pa) + p[1] * Math.sin(pa);
  const w = -p[0] * Math.sin(pa) + p[1] * Math.cos(pa);
  if (Math.abs(u) > HALF_SIDE || Math.abs(w) > HALF_SIDE) return null;
  return Math.max(Math.abs(u), Math.abs(w)) / HALF_SIDE;
}

// Returns exposures sorted by time: {id, detector, mjd, date, release, url}
export async function findExposures(ra, dec, signal) {
  return (await findExposuresDetailed(ra, dec, signal)).exposures;
}

// Like findExposures, but a failed tile leaves the rest usable and is reported:
// {exposures, tiles, failedTiles}. Throws only if every needed tile failed.
export async function findExposuresDetailed(ra, dec, signal) {
  const index = await withAbort(loadIndex(), signal);
  const keys = tilesNear(ra, dec, SEARCH_R, index.tileDeg).filter(k => index.tiles[k]);
  const settled = await Promise.allSettled(keys.map(k => loadTile(k, signal)));
  const aborted = settled.find(r => r.status === 'rejected' && r.reason?.name === 'AbortError');
  if (aborted) throw aborted.reason;
  const failedTiles = keys.filter((_, i) => settled[i].status === 'rejected');
  if (keys.length && failedTiles.length === keys.length) {
    const cause = settled[0].reason?.message || String(settled[0].reason);
    throw new Error(`Could not load the SPHEREx index for this position (${cause}), so coverage is unknown. Search again to retry.`);
  }
  const buffers = settled.filter(r => r.status === 'fulfilled').map(r => r.value);
  const out = [];
  for (const buf of buffers) {
    const v = new DataView(buf);
    for (let o = 0; o + index.rowBytes <= buf.byteLength; o += index.rowBytes) {
      const edge = contains(v, o, ra, dec);
      if (edge !== null) out.push({ ...decodeRow(v, o, index), edge });
    }
  }
  return { exposures: deduplicateExposures(out), tiles: keys.length, failedTiles };
}

// Exposures that caught a moving object. positionAt(mjd) -> {ra, dec, vmag} | null.
// Each result carries the object's position at that exposure's time.
export async function findAlongPath(points, positionAt, signal, onProgress) {
  return (await findAlongPathDetailed(points, positionAt, signal, onProgress)).exposures;
}

// Like findAlongPath, but failed tiles are reported: {exposures, tiles, failedTiles}.
// Throws only if every needed tile failed.
export async function findAlongPathDetailed(points, positionAt, signal, onProgress) {
  const index = await withAbort(loadIndex(), signal);
  const keys = new Set();
  for (const p of points) for (const k of tilesNear(p.ra, p.dec, SEARCH_R, index.tileDeg)) if (index.tiles[k]) keys.add(k);
  const list = [...keys];
  const out = [];
  const failedTiles = [];
  let done = 0, cause = null;
  const queue = [...list];
  const worker = async () => {
    while (queue.length) {
      const key = queue.shift();
      let buf;
      try {
        buf = await loadTile(key, signal);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        failedTiles.push(key);
        cause ??= e;
        onProgress?.(++done, list.length);
        continue;
      }
      const v = new DataView(buf);
      for (let o = 0; o + index.rowBytes <= buf.byteLength; o += index.rowBytes) {
        const mjd = v.getFloat32(o + 8, true) + index.mjd0;
        const pos = positionAt(mjd);
        if (!pos) continue;
        const edge = contains(v, o, pos.ra, pos.dec);
        if (edge !== null) out.push({ ...decodeRow(v, o, index), edge, obj: pos });
      }
      onProgress?.(++done, list.length);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  if (list.length && failedTiles.length === list.length) {
    throw new Error(`Could not load the SPHEREx index along this path (${cause.message || cause}), so coverage is unknown. Search again to retry.`);
  }
  return { exposures: deduplicateExposures(out), tiles: list.length, failedTiles };
}
