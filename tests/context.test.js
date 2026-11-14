import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchContext, parseVizierTSV, projectContextSources } from '../js/context.js';

const gaiaTable = `#Table I_355_gaiadr3:
#Column\tSource
_r\tSource\tRA_ICRS\tDE_ICRS\tpmRA\tpmDE
arcmin\t \tdeg\tdeg\tmas/yr\tmas/yr
-------\t-------------------\t---------------\t---------------\t---------\t---------
0.0838\t123456789\t359.99990000000\t0.00000000000\t3600000.000\t0.000
0.1097\t987654321\t12.00000000000\t45.00000000000\t?\t
`;

const wiseTable = `#Table II_328_allwise:
AllWISE\tRAJ2000\tDEJ2000\tW1mag\tW2mag
 \tdeg\tdeg\tmag\tmag
-------------------\t-----------\t-----------\t------\t------
WISEA J064507.44-164417.9\t101.2810183\t-16.7383126\t9.273\t8.528
`;

test('parses Gaia DR3 epoch, pmRA*cos(dec), missing motion, and identifiers', () => {
  const { sources } = parseVizierTSV(gaiaTable, 'gaia');
  assert.equal(sources.length, 2);
  assert.equal(sources[0].catalog, 'Gaia DR3');
  assert.equal(sources[0].epoch, 2016);
  assert.equal(sources[0].pmraConvention, 'mu_alpha*cos(dec)');
  assert.equal(sources[0].pmra, 3_600_000);
  assert.equal(sources[1].pmra, null);
  assert.equal(sources[1].pmdec, null);
});

test('parses AllWISE coordinates without inventing an observation epoch', () => {
  const { sources } = parseVizierTSV(wiseTable, 'wise');
  assert.equal(sources[0].epoch, null);
  assert.match(sources[0].epochProvenance, /no single observation epoch/i);
  assert.equal(sources[0].w1mag, 9.273);
});

test('reports malformed VizieR responses instead of returning empty success', () => {
  assert.throws(() => parseVizierTSV('<html>service unavailable</html>', 'gaia'), /HTML error page/);
  assert.throws(() => parseVizierTSV('#ERROR\tbad query', 'wise'), /bad query/);
  assert.throws(() => parseVizierTSV('# no table here', 'gaia'), /recognized catalog table/);
});

test('accepts a valid catalog response with no matching sources', () => {
  const parsed = parseVizierTSV('#Table\tII_328_allwise:\n#Title: AllWISE\n', 'wise');
  assert.deepEqual(parsed.sources, []);
  assert.equal(parsed.truncated, false);
});

test('truncation is detectable past the display cap', () => {
  const header = 'Source\tRA_ICRS\tDE_ICRS\tpmRA\tpmDE';
  const rows = Array.from({ length: 201 }, (_, i) =>
    `${i + 1}\t1\t2\t0\t0`).join('\n');
  const parsed = parseVizierTSV(`${header}\n${rows}`, 'gaia');
  assert.equal(parsed.sources.length, 201);
  assert.equal(parsed.truncated, true);
});

test('projects Gaia motion across RA zero and keeps catalog coordinates for repeat projection', () => {
  const source = parseVizierTSV(gaiaTable, 'gaia').sources[0];
  const first = projectContextSources({ sources: [source], warnings: [] }, 2017);
  assert.ok(Math.abs(first.sources[0].ra - 0.9999) < 1e-5);
  assert.equal(first.sources[0].catalogRa, 359.9999);
  const second = projectContextSources(first, 2018);
  assert.ok(Math.abs(second.sources[0].ra - 1.9999) < 1e-5);
  assert.ok(first.warnings.some(warning => /parallax.*radial-velocity/i.test(warning)));
});

test('projects safely at a celestial pole and leaves missing-PM Gaia sources at reference epoch', () => {
  const sources = parseVizierTSV(gaiaTable, 'gaia').sources;
  const polar = { ...sources[0], ra: 123, dec: 90, pmra: 3_600_000, pmdec: 0 };
  const result = projectContextSources({ sources: [polar, sources[1]], warnings: [] }, '2017-01-01');
  assert.ok(Number.isFinite(result.sources[0].ra));
  assert.ok(result.sources[0].dec <= 90 && result.sources[0].dec >= -90);
  assert.equal(result.sources[1].positionProjected, false);
  assert.equal(result.sources[1].positionEpoch, 2016);
  assert.ok(result.warnings.some(warning => /lacked complete proper motion/i.test(warning)));
});

test('leaves WISE static and labels its missing single epoch', () => {
  const wise = parseVizierTSV(wiseTable, 'wise').sources[0];
  const result = projectContextSources({ sources: [wise], warnings: [] }, 2025);
  assert.equal(result.sources[0].ra, wise.ra);
  assert.equal(result.sources[0].dec, wise.dec);
  assert.equal(result.sources[0].positionEpoch, null);
  assert.ok(result.warnings.some(warning => /static catalog coordinates/i.test(warning)));
});

test('fetchContext bounds VizieR requests and returns explicit partial-catalog failures', async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(new URL(url));
    if (url.includes('I%2F355%2Fgaiadr3')) return { ok: true, text: async () => gaiaTable };
    if (url.includes('II%2F328%2Fallwise')) throw new TypeError('Failed to fetch');
    throw new Error('unexpected catalog request');
  };
  try {
    const result = await fetchContext(0, 90, 0.5);
    assert.equal(result.sources.length, 2);
    assert.ok(result.warnings.some(warning => /AllWISE catalog lookup failed.*network or browser CORS failure/.test(warning)));
    assert.equal(requested.length, 2);
    for (const url of requested) {
      assert.equal(url.searchParams.get('-out.max'), '201');
      assert.equal(url.searchParams.get('-out.add'), '_r');
      assert.equal(url.searchParams.get('-sort'), '_r');
      assert.equal(url.searchParams.get('-c.rm'), '30');
      assert.equal(url.searchParams.get('-c'), '0 90');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchContext rejects invalid bounds and all-catalog failures with actionable errors', async () => {
  await assert.rejects(fetchContext(360, 0, 0.1, { catalog: 'gaia' }), /ra must be in/);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  try {
    await assert.rejects(fetchContext(0, 0, 0.1, { catalog: 'wise' }), /AllWISE catalog lookup failed.*retry/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
