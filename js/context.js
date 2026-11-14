// Gaia DR3 and AllWISE context from the VizieR ASU service.

const VIZIER = 'https://vizier.cfa.harvard.edu/viz-bin/asu-tsv';
const MAX_RADIUS_DEG = 2;
const MAX_SOURCES = 200;
const QUERY_TIMEOUT_MS = 15_000;
const DEG = Math.PI / 180;
const MAS_PER_DEG = 3_600_000;

const CATALOGS = {
  gaia: {
    name: 'Gaia DR3',
    source: 'I/355/gaiadr3',
    fields: 'Source,RA_ICRS,DE_ICRS,pmRA,pmDE',
  },
  wise: {
    name: 'AllWISE',
    source: 'II/328/allwise',
    fields: 'AllWISE,RAJ2000,DEJ2000,W1mag,W2mag',
  },
};

function finiteNumber(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new TypeError(`${name} must be a finite number.`);
  return n;
}

function numericCell(value) {
  const s = String(value ?? '').trim();
  if (!s || s === '?' || s === '--' || /^nan$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseRows(text, catalog) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('VizieR returned an empty response.');
  if (/<html[\s>]/i.test(text)) throw new Error('VizieR returned an HTML error page instead of catalog data.');

  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const serviceError = lines.find(line => /^#(?:ERROR|WARNING)\b/i.test(line.trim()));
  if (serviceError) throw new Error(serviceError.replace(/^#\s*/, '').trim());

  const expectedTable = catalog === 'gaia' ? 'I_355_gaiadr3' : 'II_328_allwise';
  const hasExpectedTable = lines.some(line => line.startsWith(`#Table\t${expectedTable}:`));
  let header = null;
  const records = [];
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const cells = line.split('\t');
    if (!header && cells.some(cell => /^(Source|AllWISE)$/.test(cell.trim()))) {
      header = cells.map(cell => cell.trim());
      continue;
    }
    if (!header || /^[-\s]*$/.test(line)) continue;
    if (!cells[header.indexOf(catalog === 'gaia' ? 'Source' : 'AllWISE')]?.trim()) continue;
    if (cells.every(cell => /^[-\s]*$/.test(cell))) continue;
    records.push(Object.fromEntries(header.map((name, i) => [name, (cells[i] ?? '').trim()])));
  }
  if (!header && hasExpectedTable) return [];
  if (!header) throw new Error('VizieR response did not contain a recognized catalog table.');
  return records;
}

function sourceFromRow(row, catalog) {
  if (catalog === 'gaia') {
    const ra = numericCell(row.RA_ICRS), dec = numericCell(row.DE_ICRS);
    if (ra === null || dec === null || ra < 0 || ra >= 360 || dec < -90 || dec > 90) {
      throw new Error('VizieR returned a Gaia row with invalid coordinates.');
    }
    const id = row.Source;
    if (!id) throw new Error('VizieR returned a Gaia row without its source identifier.');
    return {
      id,
      catalog: CATALOGS.gaia.name,
      ra,
      dec,
      epoch: 2016.0,
      pmra: numericCell(row.pmRA),
      pmdec: numericCell(row.pmDE),
      pmraConvention: 'mu_alpha*cos(dec)',
      referenceFrame: 'ICRS',
      epochProvenance: 'Gaia DR3 I/355/gaiadr3 coordinates and proper motions at reference epoch J2016.0.',
      label: `Gaia DR3 ${id}`,
    };
  }

  const ra = numericCell(row.RAJ2000), dec = numericCell(row.DEJ2000);
  if (ra === null || dec === null || ra < 0 || ra >= 360 || dec < -90 || dec > 90) {
    throw new Error('VizieR returned an AllWISE row with invalid coordinates.');
  }
  const id = row.AllWISE;
  if (!id) throw new Error('VizieR returned an AllWISE row without its designation.');
  return {
    id,
    catalog: CATALOGS.wise.name,
    ra,
    dec,
    epoch: null,
    pmra: null,
    pmdec: null,
    referenceFrame: 'J2000',
    epochProvenance: 'AllWISE II/328/allwise J2000 catalog coordinates; no single observation epoch is assigned.',
    label: `AllWISE ${id}`,
    w1mag: numericCell(row.W1mag),
    w2mag: numericCell(row.W2mag),
  };
}

// Parse VizieR's TSV output. Exported to make schema/error handling testable offline.
export function parseVizierTSV(text, catalog) {
  if (!Object.hasOwn(CATALOGS, catalog)) throw new TypeError('catalog must be "gaia" or "wise".');
  const rows = parseRows(text, catalog);
  const sources = rows.map(row => sourceFromRow(row, catalog));
  return { sources, truncated: sources.length > MAX_SOURCES };
}

function validateCatalog(catalog) {
  if (catalog !== 'gaia' && catalog !== 'wise' && catalog !== 'both') {
    throw new TypeError('catalog must be "gaia", "wise", or "both".');
  }
}

function catalogUrl(catalog, ra, dec, radiusDeg) {
  const spec = CATALOGS[catalog];
  const params = new URLSearchParams({
    '-source': spec.source,
    '-c': `${ra} ${dec}`,
    // VizieR's -c.rm radius unit is arcminutes.
    '-c.rm': String(radiusDeg * 60),
    '-out': spec.fields,
    '-out.add': '_r',
    '-sort': '_r',
    '-out.max': String(MAX_SOURCES + 1),
  });
  return `${VIZIER}?${params}`;
}

async function requestCatalog(catalog, ra, dec, radiusDeg, signal) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, QUERY_TIMEOUT_MS);
  try {
    const response = await fetch(catalogUrl(catalog, ra, dec, radiusDeg), { signal: controller.signal });
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError');
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = parseVizierTSV(await response.text(), catalog);
    const warnings = [];
    if (parsed.truncated) {
      parsed.sources.length = MAX_SOURCES;
      warnings.push(`${CATALOGS[catalog].name} results were truncated to ${MAX_SOURCES} sources; reduce the search radius to see a complete result.`);
    }
    return { sources: parsed.sources, warnings };
  } catch (error) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError');
    const cause = timedOut ? `timed out after ${QUERY_TIMEOUT_MS / 1000} seconds` :
      (error instanceof TypeError ? 'network or browser CORS failure' : error.message);
    throw new Error(`${CATALOGS[catalog].name} catalog lookup failed (${cause}). Check your connection and retry; no catalog result was returned.`, { cause: error });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// catalog: "gaia" | "wise" | "both" (default). Radius is degrees, limited to 2°;
// up to 200 rows per catalog are returned. The caller's AbortSignal cancels all queries.
export async function fetchContext(ra, dec, radiusDeg, { catalog = 'both', signal } = {}) {
  ra = finiteNumber(ra, 'ra');
  dec = finiteNumber(dec, 'dec');
  radiusDeg = finiteNumber(radiusDeg, 'radiusDeg');
  validateCatalog(catalog);
  if (ra < 0 || ra >= 360) throw new RangeError('ra must be in [0, 360).');
  if (dec < -90 || dec > 90) throw new RangeError('dec must be in [-90, 90].');
  if (radiusDeg <= 0 || radiusDeg > MAX_RADIUS_DEG) {
    throw new RangeError(`radiusDeg must be greater than 0 and no more than ${MAX_RADIUS_DEG} degrees.`);
  }

  const selected = catalog === 'both' ? ['gaia', 'wise'] : [catalog];
  const settled = await Promise.allSettled(selected.map(c => requestCatalog(c, ra, dec, radiusDeg, signal)));
  const failures = settled.flatMap((item, index) => item.status === 'rejected'
    ? [{ catalog: selected[index], error: item.reason }] : []);
  const successes = settled.filter(item => item.status === 'fulfilled').map(item => item.value);
  if (!successes.length) {
    throw new Error(failures.map(item => item.error.message).join(' '));
  }
  const warnings = successes.flatMap(item => item.warnings);
  for (const failure of failures) warnings.push(failure.error.message);
  if (selected.includes('wise')) {
    warnings.push('AllWISE positions are static catalog coordinates; the catalog does not provide a single epoch for these sources.');
  }
  return { sources: successes.flatMap(item => item.sources), warnings };
}

function decimalYear(date) {
  if (typeof date === 'number') {
    if (!Number.isFinite(date)) throw new TypeError('date must be a finite decimal year, Date, or date string.');
    return date;
  }
  if (!(date instanceof Date) && typeof date !== 'string') {
    throw new TypeError('date must be a decimal year, Date, or date string.');
  }
  const value = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(value.getTime())) throw new TypeError('date must be a decimal year, Date, or valid date string.');
  const year = value.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  return year + (value.getTime() - start) / (end - start);
}

function propagateGaia(raDeg, decDeg, pmra, pmdec, years) {
  const ra = raDeg * DEG, dec = decDeg * DEG;
  const r = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
  // pmra is Gaia's mu_alpha*cos(dec); using the east/north tangent basis avoids
  // dividing by cos(dec), which is singular at the poles.
  const east = [-Math.sin(ra), Math.cos(ra), 0];
  const north = [-Math.sin(dec) * Math.cos(ra), -Math.sin(dec) * Math.sin(ra), Math.cos(dec)];
  const eastMotion = pmra * years, northMotion = pmdec * years;
  const motion = Math.hypot(eastMotion, northMotion);
  if (!motion) return { ra: ((raDeg % 360) + 360) % 360, dec: decDeg };
  const theta = motion / MAS_PER_DEG * DEG;
  const direction = east.map((v, i) => (v * eastMotion + north[i] * northMotion) / motion);
  const moved = r.map((v, i) => v * Math.cos(theta) + direction[i] * Math.sin(theta));
  const nextRa = Math.atan2(moved[1], moved[0]) / DEG;
  const nextDec = Math.asin(Math.max(-1, Math.min(1, moved[2]))) / DEG;
  return { ra: (nextRa + 360) % 360, dec: nextDec };
}

// Returns a new {sources,warnings} result with Gaia positions propagated to date.
// WISE sources retain their catalog coordinates and null epoch.
export function projectContextSources(result, date) {
  if (!result || !Array.isArray(result.sources)) throw new TypeError('result must contain a sources array.');
  const targetEpoch = decimalYear(date);
  const warnings = [...(Array.isArray(result.warnings) ? result.warnings : [])];
  let missingMotion = 0;
  let movedGaia = false;
  const includesWise = result.sources.some(source => source.catalog === CATALOGS.wise.name);
  const sources = result.sources.map(source => {
    if (source.catalog !== CATALOGS.gaia.name) {
      return { ...source, positionEpoch: null, positionEpochRequested: targetEpoch, positionProjected: false };
    }
    const referenceRa = source.catalogRa ?? source.ra;
    const referenceDec = source.catalogDec ?? source.dec;
    const hasMotion = Number.isFinite(source.pmra) && Number.isFinite(source.pmdec);
    if (!hasMotion) {
      missingMotion++;
      return {
        ...source,
        ra: referenceRa,
        dec: referenceDec,
        positionEpoch: source.epoch,
        positionEpochRequested: targetEpoch,
        positionProjected: false,
      };
    }
    const position = propagateGaia(referenceRa, referenceDec, source.pmra, source.pmdec, targetEpoch - source.epoch);
    movedGaia = true;
    return {
      ...source,
      catalogRa: referenceRa,
      catalogDec: referenceDec,
      ...position,
      positionEpoch: targetEpoch,
      positionEpochRequested: targetEpoch,
      positionProjected: true,
    };
  });
  if (movedGaia) {
    warnings.push('Gaia positions use linear proper motion only; parallax, radial-velocity/perspective effects, and full astrometric propagation corrections are not applied.');
  }
  if (missingMotion) {
    warnings.push(`${missingMotion} Gaia source${missingMotion === 1 ? '' : 's'} lacked complete proper motion and remain at their catalog reference position.`);
  }
  if (includesWise && !warnings.some(warning => /AllWISE positions are static catalog coordinates/i.test(warning))) {
    warnings.push('AllWISE positions are static catalog coordinates; the catalog does not provide a single epoch for these sources.');
  }
  return { ...result, sources, warnings };
}
