"use strict";
// Gaia DR3 overlay tests (Person 3 task 2). Offline: every VizieR response is a fake fetch.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { ROOT, until } = require("./helpers.cjs");

const Gaia = require(path.join(ROOT, "static", "gaia.js"));

const FIELD = { ra: 10, dec: 20, fovArcmin: 3 };

function table(rows) {
  return [
    "#Table\tI_355_gaiadr3:",
    "_r\tSource\tRA_ICRS\tDE_ICRS\tpmRA\tpmDE",
    "arcmin\t \tdeg\tdeg\tmas/yr\tmas/yr",
    "-------\t----\t-----\t-----\t-----\t-----",
    ...rows.map((r, i) => `0.0${i}\t${r.join("\t")}`),
    "",
  ].join("\n");
}
const EMPTY_TABLE = "#Table\tI_355_gaiadr3:\n#Title: Gaia DR3 Part 1. Main source\n";
const manyRows = (n) => Array.from({ length: n }, (_, i) => [String(i + 1), "10", "20", "0", "0"]);

// Fake VizieR. respond(url) -> body string | [status, body] | Error (thrown) | Promise of those.
function vizier(respond) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(new URL(url));
    const out = await respond(url, init);
    if (out instanceof Error) throw out;
    const [status, body] = Array.isArray(out) ? out : [200, out];
    return { ok: status < 400, status, text: async () => body };
  };
  return { fetch, calls };
}

function fixture(respond) {
  const dom = new JSDOM(`<input id="toggle" type="checkbox"><div id="panel"><span id="status"></span>
    <button id="action" type="button"></button><p id="provenance"></p></div>
    <svg id="svg" viewBox="0 0 128 128"></svg>`);
  const d = dom.window.document;
  const els = Object.fromEntries(["toggle", "panel", "status", "action", "provenance", "svg"].map((id) => [id, d.getElementById(id)]));
  const backend = vizier(respond);
  const overlay = Gaia.createOverlay(els, { fetch: backend.fetch });
  const turnOn = () => { els.toggle.checked = true; els.toggle.dispatchEvent(new dom.window.Event("change")); };
  const click = (el) => el.dispatchEvent(new dom.window.MouseEvent("click"));
  return { dom, els, overlay, calls: backend.calls, turnOn, click, markers: () => els.svg.querySelectorAll("circle") };
}

// ---------------------------------------------------------------- parser

test("P3: parses Gaia rows, keeps pmRA*cos(dec) and leaves missing motion null", () => {
  const { sources, truncated } = Gaia.parseVizierTSV(table([["111", "10.0", "20.0", "100.5", "-50"], ["222", "10.001", "20.001", "?", ""]]));
  assert.equal(sources.length, 2);
  assert.deepEqual(sources[0], { id: "111", ra: 10, dec: 20, epoch: 2016, pmra: 100.5, pmdec: -50 });
  assert.equal(sources[1].pmra, null);
  assert.equal(sources[1].pmdec, null);
  assert.equal(truncated, false);
});

test("P3: a valid Gaia table with no rows is an empty result, not an error", () => {
  assert.deepEqual(Gaia.parseVizierTSV(EMPTY_TABLE), { sources: [], truncated: false });
});

test("P3: malformed responses throw instead of reading as no sources", () => {
  assert.throws(() => Gaia.parseVizierTSV(""), /empty response/);
  assert.throws(() => Gaia.parseVizierTSV("<html><body>503</body></html>"), /HTML error page/);
  assert.throws(() => Gaia.parseVizierTSV("#ERROR\tbad -c value"), /bad -c value/);
  assert.throws(() => Gaia.parseVizierTSV("# nothing useful"), /recognized Gaia DR3 table/);
  assert.throws(() => Gaia.parseVizierTSV("#Table\tII_328_allwise:\n"), /recognized Gaia DR3 table/, "another catalog's table is not Gaia");
  assert.throws(() => Gaia.parseVizierTSV(table([["1", "400", "20", "0", "0"]])), /invalid coordinates/);
});

// ---------------------------------------------------------------- request

test("P3: the cone is the field's circumscribed circle, nearest-first, with one extra row", () => {
  const url = new URL(Gaia.queryUrl(FIELD));
  assert.equal(`${url.origin}${url.pathname}`, Gaia.VIZIER_ASU_URL);
  assert.equal(url.searchParams.get("-source"), Gaia.GAIA_CATALOG);
  assert.equal(url.searchParams.get("-c"), "10 20");
  assert.equal(Number(url.searchParams.get("-c.rm")), 3 / Math.SQRT2);
  assert.equal(url.searchParams.get("-out.max"), "201");
  assert.equal(url.searchParams.get("-sort"), "_r");
  assert.equal(Number(new URL(Gaia.queryUrl({ ...FIELD, fovArcmin: 12 })).searchParams.get("-c.rm")), 12 / Math.SQRT2);
  assert.throws(() => Gaia.queryUrl({ ...FIELD, ra: 360 }), /ra must be/);
});

test("P3: 201 rows are capped to the nearest 200 and flagged; 200 rows are not", async () => {
  const capped = await Gaia.fetchGaia(FIELD, { fetch: vizier(() => table(manyRows(201))).fetch });
  assert.equal(capped.sources.length, 200);
  assert.equal(capped.capped, true);
  const full = await Gaia.fetchGaia(FIELD, { fetch: vizier(() => table(manyRows(200))).fetch });
  assert.equal(full.sources.length, 200);
  assert.equal(full.capped, false);
  assert.match(full.queriedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("P3: HTTP, network, HTML and timeout failures say Gaia was not checked", async () => {
  const fail = (respond, opts = {}) => Gaia.fetchGaia(FIELD, { fetch: vizier(respond).fetch, ...opts });
  await assert.rejects(fail(() => [500, "oops"]), /^Error: Query failed, Gaia not checked \(HTTP 500\)\.$/);
  await assert.rejects(fail(() => new TypeError("Failed to fetch")), /network or browser CORS failure/);
  await assert.rejects(fail(() => "<html>busy</html>"), /Gaia not checked \(VizieR returned an HTML error page/);
  const hang = (_url, init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  await assert.rejects(fail(hang, { timeoutMs: 20 }), /timed out after 0\.02 s/);
  assert.equal(Gaia.QUERY_TIMEOUT_MS, 15000);
});

test("P3: a cancelled query rejects as AbortError, not as a failure", async () => {
  const controller = new AbortController();
  const hang = (_url, init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  const pending = Gaia.fetchGaia(FIELD, { fetch: vizier(hang).fetch, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

// ---------------------------------------------------------------- propagation and projection

test("P3: proper motion propagates across RA zero and from J2016.0 to a frame date", () => {
  // 1 deg/yr eastward at the equator.
  const moved = Gaia.propagate(359.9999, 0, 3600000, 0, 1);
  assert.ok(Math.abs(moved.ra - 0.9999) < 1e-5);
  assert.ok(Math.abs(moved.dec) < 1e-9);
  const [p] = Gaia.propagateSources([{ id: "1", ra: 359.9999, dec: 0, epoch: 2016, pmra: 3600000, pmdec: 0 }], 2018);
  assert.ok(Math.abs(p.ra - 1.9999) < 1e-5);
  assert.equal(p.projected, true);
  assert.ok(Math.abs(Gaia.decimalYear("2025-07-02T12:00:00Z") - 2025.5) < 0.002);
});

test("P3: propagation is finite at a pole and leaves missing-motion sources at J2016.0", () => {
  const polar = Gaia.propagate(123, 90, 3600000, 0, 1);
  assert.ok(Number.isFinite(polar.ra) && polar.dec <= 90 && polar.dec >= -90);
  const [still] = Gaia.propagateSources([{ id: "2", ra: 12, dec: 45, epoch: 2016, pmra: null, pmdec: null }], "2026-01-01");
  assert.deepEqual([still.ra, still.dec, still.projected], [12, 45, false]);
});

test("P3: projection matches the 128x128 north-up, east-left grid", () => {
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  const c = Gaia.projectToGrid(10, 20, FIELD);
  assert.ok(near(c.x, 64) && near(c.y, 64), "field center is the grid center");
  const half = 1.5 / 60; // half of a 3 arcmin field, in degrees
  assert.ok(Math.abs(Gaia.projectToGrid(10, 20 + half, FIELD).y) < 1e-3, "north edge is y = 0");
  const east = Gaia.projectToGrid(10 + half / Math.cos(20 * Math.PI / 180), 20, FIELD);
  assert.ok(Math.abs(east.x) < 0.01, "east edge is x = 0 (east left)");
  assert.equal(Gaia.projectToGrid(190, -20, FIELD), null, "antipode is behind the tangent plane");
});

// ---------------------------------------------------------------- overlay controller

test("P3: the overlay starts off and sends nothing", () => {
  const f = fixture(() => { throw new Error("must not be called"); });
  assert.equal(f.els.toggle.checked, false);
  assert.equal(f.els.panel.hidden, true);
  f.overlay.setField(FIELD);
  f.overlay.setFrameDate("2025-09-15T04:48:00Z");
  assert.equal(f.calls.length, 0);
  assert.equal(f.markers().length, 0);
});

test("P3: restoring gaia=1 turns the toggle on but waits for Query Gaia", async () => {
  const f = fixture(() => table([["111", "10", "20", "0", "0"]]));
  f.overlay.restore(true);
  assert.equal(f.els.toggle.checked, true);
  assert.equal(f.els.status.textContent, "Gaia not queried yet. Search a field first.");
  assert.equal(f.els.action.hidden, false);
  assert.equal(f.els.action.textContent, "Query Gaia");
  assert.equal(f.els.action.disabled, true, "nothing to query before a search");
  f.overlay.setField(FIELD);
  assert.equal(f.els.status.textContent, "Gaia not queried yet.");
  assert.equal(f.els.action.disabled, false);
  assert.equal(f.calls.length, 0, "no request until the user clicks");
  f.click(f.els.action);
  await until(() => f.overlay.snapshot().phase === "ready", "ready");
  assert.equal(f.calls.length, 1);
});

test("P3: a failure reads as not checked with Retry; an empty retry reads as 0 sources", async () => {
  let answer = "<html>overloaded</html>";
  const f = fixture(() => answer);
  f.overlay.setField(FIELD);
  f.turnOn();
  await until(() => f.overlay.snapshot().phase === "failed", "failed");
  assert.match(f.els.status.textContent, /^Query failed, Gaia not checked \(VizieR returned an HTML error page/);
  assert.doesNotMatch(f.els.status.textContent, /0 Gaia/);
  assert.ok(f.els.status.classList.contains("error"));
  assert.equal(f.els.action.textContent, "Retry");
  assert.equal(f.els.action.hidden, false);
  assert.equal(f.els.provenance.textContent, "");
  answer = EMPTY_TABLE;
  f.click(f.els.action);
  await until(() => f.overlay.snapshot().phase === "ready", "ready");
  assert.equal(f.els.status.textContent, "0 Gaia DR3 sources in this field.");
  assert.equal(f.els.action.hidden, true);
  assert.equal(f.calls.length, 2);
});

test("P3: more than 200 rows reads as capped at 200", async () => {
  const f = fixture(() => table(manyRows(201)));
  f.overlay.setField(FIELD);
  f.turnOn();
  await until(() => f.overlay.snapshot().phase === "ready", "ready");
  assert.match(f.els.status.textContent, /^Capped at 200: showing the 200 Gaia DR3 sources nearest the center/);
});

test("P3: frame changes re-propagate markers without re-querying; provenance names the epoch", async () => {
  // One source moving 1 arcsec/yr north (10 arcsec from 2016 to 2026) and one without proper motion.
  const f = fixture(() => table([["111", "10", "20", "0", "1000"], ["222", "10.005", "20.005", "", ""]]));
  f.overlay.setField(FIELD);
  f.turnOn();
  await until(() => f.overlay.snapshot().phase === "ready", "ready");
  assert.equal(f.markers().length, 0, "no frame displayed, no markers");
  assert.match(f.els.provenance.textContent, /propagation to the displayed frame's date \(no frame displayed\)\.$/);
  f.overlay.setFrameDate("2016-01-01T00:00:00Z");
  const y2016 = Number(f.markers()[0].getAttribute("cy"));
  f.overlay.setFrameDate("2026-01-01T00:00:00Z");
  const y2026 = Number(f.markers()[0].getAttribute("cy"));
  assert.ok(y2026 < y2016, "northward motion moves the marker up");
  assert.ok(Math.abs((y2016 - y2026) - 10 / (180 / 128)) < 0.05, "10 arcsec at 180/128 arcsec per grid unit");
  assert.equal(f.calls.length, 1, "frames only re-propagate");
  assert.equal(f.markers().length, 2);
  assert.equal(f.markers()[1].getAttribute("class"), "gaia-marker no-pm");
  assert.match(f.els.status.textContent, /2 Gaia DR3 sources in the query cone\. 2 inside the image\. 1 without proper motion/);
  assert.match(f.els.provenance.textContent,
    /^Gaia DR3 \(I\/355\/gaiadr3\), queried via VizieR ASU on \d{4}-\d{2}-\d{2} UTC, linear proper-motion propagation to 2026-01-01 \(2026\.000\)\.$/);
  f.overlay.setFrameDate(null);
  assert.equal(f.els.svg.style.display, "none");
});

test("P3: a new search aborts the query in flight; the same field again comes from cache", async () => {
  let signal;
  let release;
  const f = fixture((_url, init) => {
    signal = init.signal;
    return new Promise((resolve) => { release = () => resolve(table([["111", "10", "20", "0", "0"]])); });
  });
  f.overlay.setField(FIELD);
  f.turnOn();
  assert.equal(f.overlay.snapshot().phase, "loading");
  f.overlay.setField(null); // search started
  assert.equal(signal.aborted, true);
  assert.equal(f.overlay.snapshot().phase, "pending");
  release();
  f.overlay.setField(FIELD);
  f.click(f.els.action);
  await until(() => !!release && f.calls.length === 2, "second request");
  release();
  await until(() => f.overlay.snapshot().phase === "ready", "ready");
  f.overlay.setField({ ...FIELD, fovArcmin: 6 });
  assert.equal(f.overlay.snapshot().phase, "pending", "a different field needs a new query");
  f.overlay.setField(FIELD);
  assert.equal(f.overlay.snapshot().phase, "ready", "cached field shown without a request");
  assert.equal(f.calls.length, 2);
});

test("P3: turning the toggle off clears markers and cancels", async () => {
  const f = fixture(() => table([["111", "10", "20", "0", "0"]]));
  f.overlay.setField(FIELD);
  f.overlay.setFrameDate("2025-09-15T00:00:00Z");
  f.turnOn();
  await until(() => f.markers().length === 1, "marker");
  f.els.toggle.checked = false;
  f.els.toggle.dispatchEvent(new f.dom.window.Event("change"));
  assert.equal(f.markers().length, 0);
  assert.equal(f.els.panel.hidden, true);
  assert.equal(f.overlay.isEnabled(), false);
});
