"use strict";
// Viewer component tests. Tags: O1-O3 objectives, C considerations, P1 Person 1 (docs/TESTING.md).

const test = require("node:test");
const assert = require("node:assert/strict");
const { rec, searchBody, frameBody, fakeFetch, loadApp, until, click, key, search, load } = require("./helpers.cjs");

const DAY = 1;
// Barnard-like field: D1 on three dates (two exposures on the first), D3 once, QR3 later.
function barnardRecords() {
  return [
    rec(0, { mjd: 60914.20 }), rec(1, { mjd: 60914.25 }), rec(2, { mjd: 60930.2 }),
    rec(3, { mjd: 60931.2, band: "SPHEREx-D3", range: [1.63, 2.41] }),
    rec(4, { mjd: 61270.2, collection: "spherex_qr3" }),
  ];
}

function backend({ records = barnardRecords(), statuses, extra, frame } = {}) {
  return fakeFetch({
    search: () => [200, searchBody(records, statuses, extra)],
    frame: frame ?? ((id) => [200, frameBody(id)]),
  });
}

function input(app, id, value) {
  app.$(id).value = value;
  app.$(id).dispatchEvent(new app.w.Event("input", { bubbles: true }));
}

function change(app, id, value) {
  if (value !== undefined) app.$(id).value = value;
  app.$(id).dispatchEvent(new app.w.Event("change", { bubbles: true }));
}

function tableChecks(app) { return [...app.$("records").querySelectorAll("input[type=checkbox]")]; }

// ---------------------------------------------------------------- O1, O3, C*

test("O1/C: coordinates, field of view and release in the URL prefill the form", () => {
  const app = loadApp({ url: "http://localhost:8000/?ra=76.956&dec=30.401&fov=6&release=qr3&deep=1" }); // RW Aur
  assert.equal(app.$("ra").value, "76.956");
  assert.equal(app.$("dec").value, "30.401");
  assert.equal(app.$("fov").value, "6");
  assert.equal(app.$("release").value, "qr3");
  assert.equal(app.$("deep").checked, true);
  assert.equal(app.$("sample").value, "custom");
});

test("O1: without URL parameters the form starts on Barnard's Star, DR1 + QR3, 3 arcmin", () => {
  const app = loadApp();
  assert.equal(app.$("sample").value, "barnard");
  assert.equal(Number(app.$("ra").value), app.viewer.samples.barnard[0]);
  assert.equal(app.$("release").value, "both");
  assert.equal(app.$("fov").value, "3");
  assert.equal(app.$("deep").checked, false);
});

test("O3/P1: WISE 0855 sample uses the 2026 position; the challenge position stays available", () => {
  const app = loadApp();
  change(app, "sample", "wise");
  assert.deepEqual([Number(app.$("ra").value), Number(app.$("dec").value)], [133.75947, -7.242557]);
  change(app, "sample", "wiseref");
  // Challenge text: RA 08h55m10.831s, Dec -7d14m42.53s
  assert.ok(Math.abs(Number(app.$("ra").value) - (8 + 55 / 60 + 10.831 / 3600) * 15) < 1e-6);
  assert.ok(Math.abs(Number(app.$("dec").value) - -(7 + 14 / 60 + 42.53 / 3600)) < 1e-6);
  change(app, "sample", "barnard");
  assert.equal(Number(app.$("dec").value), 4.768204);
  change(app, "sample", "custom"); // keeps whatever is typed
  assert.equal(Number(app.$("dec").value), 4.768204);
});

test("O1: typing coordinates switches the sample selector to custom", () => {
  const app = loadApp();
  input(app, "dec", "-56.786"); // Epsilon Indi
  assert.equal(app.$("sample").value, "custom");
});

test("O1/C: search sends RA/Dec, FOV, release and deep flag, then makes the URL shareable", async () => {
  const fake = backend();
  const app = loadApp({ fetch: fake.fetch });
  input(app, "ra", "330.84"); input(app, "dec", "-56.786");
  app.$("fov").value = "12"; app.$("release").value = "dr1"; app.$("deep").checked = true;
  await search(app);
  const params = new URLSearchParams(fake.calls[0].split("?")[1]);
  assert.deepEqual(Object.fromEntries(params), { ra: "330.84", dec: "-56.786", fov: "12", release: "dr1", deep: "1" });
  assert.equal(new URL(app.w.location.href).search, `?${params}`);
  assert.equal(app.$("field-label").textContent, "269.4463, 4.7682 / ICRS", "4-decimal rounding of the searched center");
});

// ------------------------------------------------------------- P1 search UX

test("P1: a successful search lists detectors, picks first/last dates and fills the timeline", async () => {
  const app = loadApp({ fetch: backend().fetch });
  await search(app);
  assert.deepEqual([...app.$("band").options].map((o) => [o.value, o.textContent]),
    [["SPHEREx-D1", "D1 / 0.75-1.09 um"], ["SPHEREx-D3", "D3 / 1.63-2.41 um"]]);
  assert.deepEqual([...app.viewer.state.selected], ["0", "4"], "first date and last distinct date");
  assert.equal(app.$("load").textContent, "Load selected (2)");
  assert.equal(app.$("selection-summary").textContent, "4 exposures / 3 calendar dates / 2 selected");
  assert.equal(app.$("record-count").textContent, "5 TOTAL RECORDS");
  assert.match(app.$("status").textContent, /^Found 5 overlapping exposures\. Load/);
  assert.equal(app.$("warnings").hidden, true);
  assert.equal(app.doc.querySelectorAll(".obs-mark").length, 4);
  assert.equal(app.doc.querySelectorAll(".obs-mark.selected").length, 2);
  assert.equal(tableChecks(app).filter((c) => c.checked).length, 2);
});

test("P1: when one release failed, the status line says results are incomplete and warnings show", async () => {
  const statuses = [
    { collection: "spherex_dr1", status: "ok", count: 5, skipped: 0, message: "5 exposures." },
    { collection: "spherex_qr3", status: "failed", count: 0, skipped: 0, message: "IRSA down. Coverage in this collection is unknown." },
  ];
  const app = loadApp({ fetch: backend({ statuses, extra: { warnings: ["spherex_qr3: IRSA down."] } }).fetch });
  await search(app);
  assert.match(app.$("status").textContent, /Results are incomplete for spherex_qr3; see warnings/);
  assert.equal(app.$("warnings").hidden, false);
  assert.match(app.$("warnings").textContent, /spherex_qr3/);
  assert.match(app.doc.querySelector(".status-failed").textContent, /coverage unknown/);
});

test("P1: no records plus warnings reads as unknown coverage, never as 'no coverage'", async () => {
  const statuses = [{ collection: "spherex_qr3", status: "failed", count: 0, skipped: 0, message: "x" }];
  const app = loadApp({ fetch: backend({ records: [], statuses, extra: { warnings: ["spherex_qr3: x"] } }).fetch });
  await search(app);
  assert.match(app.$("status").textContent, /Coverage is unknown for failed collections/);
  assert.match(app.$("records").textContent, /No exposures in this band/);
  assert.equal(app.$("band").disabled, true);
  assert.equal(app.$("load").disabled, true);
});

test("P1: a missing release (e.g. QR3 for WISE 0855) reads as no coverage when every query answered", async () => {
  const statuses = [{ collection: "spherex_qr3", status: "empty", count: 0, skipped: 0, message: "none" }];
  const app = loadApp({ fetch: backend({ records: [], statuses }).fetch });
  await search(app);
  assert.match(app.$("status").textContent, /^No coverage in the searched collections/);
  assert.match(app.doc.querySelector(".status-empty").textContent, /searched: no exposures here/);
});

test("P1: a backend error is shown as an error, with or without a message", async () => {
  for (const [body, expected] of [[{ error: "No collection could be queried." }, /No collection could be queried/],
    [{}, /Request failed \(502\)/]]) {
    const fake = fakeFetch({ search: () => [502, body], frame: () => [500, {}] });
    const app = loadApp({ fetch: fake.fetch });
    await search(app);
    assert.match(app.$("status").textContent, expected);
    assert.ok(app.$("status").classList.contains("error"));
    assert.equal(app.$("search-button").disabled, false, "the user can retry");
  }
});

test("P1: a second search while one is running is ignored", async () => {
  let release;
  const fake = fakeFetch({ search: () => new Promise((r) => { release = () => r([200, searchBody(barnardRecords())]); }), frame: () => [200, {}] });
  const app = loadApp({ fetch: fake.fetch });
  click(app.w, app.$("search-button"));
  await until(() => release, "first search");
  await app.viewer.searchField(); // bypasses the disabled button
  assert.equal(fake.calls.length, 1);
  release();
  await until(() => app.viewer.state.search, "search result");
});

// -------------------------------------------------------- P1 timeline + selection

test("P1: clicking a timeline mark in another detector switches detector and selects that date", async () => {
  const app = loadApp({ fetch: backend().fetch });
  await search(app);
  const d3 = [...app.doc.querySelectorAll(".obs-mark")].find((m) => /, D3,/.test(m.getAttribute("aria-label")));
  click(app.w, d3);
  assert.equal(app.$("band").value, "SPHEREx-D3");
  assert.deepEqual([...app.viewer.state.selected], ["3"]);
  assert.match(app.$("status").textContent, /Selected the first of 1 D3 exposure on/);
  key(app.w, app.doc.querySelector(".obs-mark.selected"), "Enter"); // same group again: deselect
  assert.equal(app.viewer.state.selected.size, 0);
  assert.match(app.$("status").textContent, /^Deselected/);
});

test("P1: a mark with several exposures selects the first; plural wording", async () => {
  const app = loadApp({ fetch: backend().fetch });
  await search(app);
  app.viewer.state.selected.clear();
  const first = app.doc.querySelector(".obs-mark"); // D1 day with two exposures
  click(app.w, first);
  assert.deepEqual([...app.viewer.state.selected], ["0"]);
  assert.match(app.$("status").textContent, /first of 2 D1 exposures/);
});

test("P1: selection stops at 32 frames, from the timeline and from the log", async () => {
  const records = Array.from({ length: 40 }, (_, i) => rec(i, { mjd: 60900 + i }));
  const app = loadApp({ fetch: backend({ records }).fetch });
  await search(app);
  assert.equal(app.viewer.MAX_SELECTED, 32);
  app.viewer.state.selected.clear();
  for (let i = 0; i < 32; i++) app.viewer.state.selected.add(String(i));
  const free = [...app.doc.querySelectorAll(".obs-mark")].at(-2);
  click(app.w, free);
  assert.equal(app.viewer.state.selected.size, 32);
  assert.match(app.$("status").textContent, /Choose at most 32 cutouts/);
  // Log checkbox: re-render first so boxes reflect state, then try one more.
  click(app.w, app.$("suggest")); // "Pick first + last date" resets the selection to 2
  assert.equal(app.viewer.state.selected.size, 2);
  app.viewer.state.selected.clear();
  for (let i = 0; i < 32; i++) app.viewer.state.selected.add(String(i));
  app.viewer.drawTimeline();
  const box = tableChecks(app)[35];
  box.checked = true;
  box.dispatchEvent(new app.w.Event("change"));
  assert.equal(box.checked, false);
  assert.equal(app.viewer.state.selected.size, 32);
  const on = tableChecks(app)[0];
  on.checked = false;
  on.dispatchEvent(new app.w.Event("change"));
  assert.equal(app.viewer.state.selected.has("0"), false, "unchecking deselects");
  on.checked = true;
  on.dispatchEvent(new app.w.Event("change"));
  assert.equal(app.viewer.state.selected.has("0"), true, "checking selects");
});

test("P1: changing detector in the dropdown re-picks first/last dates for that detector", async () => {
  const app = loadApp({ fetch: backend().fetch });
  await search(app);
  change(app, "band", "SPHEREx-D3");
  assert.deepEqual([...app.viewer.state.selected], ["3"], "single date: only one pick");
  assert.match(app.$("status").textContent, /Band changed/);
  assert.equal(app.doc.querySelector(".obs-row.active + text, .obs-band.active").textContent.slice(0, 2), "D3");
});

// ------------------------------------------------------------- O2 loading

test("O2/P1: frames load 4 at a time and keep observation order even when they finish out of order", async () => {
  const records = Array.from({ length: 10 }, (_, i) => rec(i, { mjd: 60900 + i }));
  let inFlight = 0, maxInFlight = 0;
  const frame = async (id) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 30 - Number(id) * 2)); // later ids finish sooner
    inFlight--;
    return [200, frameBody(id, { value: Number(id) * 10 })];
  };
  const app = loadApp({ fetch: backend({ records, frame }).fetch });
  await search(app);
  records.forEach((r) => app.viewer.state.selected.add(r.id));
  app.viewer.drawTimeline();
  click(app.w, app.$("load"));
  await until(() => app.viewer.state.busy, "busy");
  assert.equal(app.$("search-button").disabled, true, "search is locked while loading");
  assert.ok(app.doc.querySelector(".obs-mark.busy"), "timeline is inert while loading");
  await until(() => /frames ready/.test(app.$("status").textContent), "frames");
  assert.equal(maxInFlight, app.viewer.LOAD_CONCURRENCY);
  assert.deepEqual(app.viewer.state.frames.map((f) => f.record.id), records.map((r) => r.id));
  assert.match(app.$("status").textContent, /^10 aligned frames ready in \d+\.\d s/);
  assert.equal(app.doc.querySelectorAll(".obs-loaded").length, 10);
  assert.equal(app.$("timeline").max, "9");
});

test("O2/C: a loaded frame shows the image, date badge, scale and its metadata incl. FLAGS and pixel source", async () => {
  const app = loadApp({ fetch: backend().fetch });
  await search(app);
  await load(app);
  assert.equal(app.$("sky").style.display, "block");
  assert.equal(app.$("empty-state").hidden, true);
  assert.match(app.$("image-badge").textContent, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z \| DR1 \| D1$/);
  assert.equal(app.$("scale").textContent, "3 arcmin full width");
  const details = app.$("frame-details").textContent;
  for (const part of [/Frame 1\/2/, /Target wavelength: 1\.0000 um \/ width 0\.0200 um/, /Finite display coverage: 99\.5%/,
    /Any FLAGS bits in cutout: 12\.5%/, /FINAST code: 0/, /Pixels from: AWS S3 \(partial read\)/]) assert.match(details, part);
  assert.ok(Number(app.$("high").value) > Number(app.$("low").value), "shared auto stretch");
  const pins = app.$("records").querySelectorAll("button");
  assert.ok(pins.length >= 2, "loaded rows can be pinned A/B");
});

test("C: missing wavelength, missing astrometry code and IRSA-sourced pixels are labelled", async () => {
  const frame = (id) => [200, { ...frameBody(id, { source: "irsa" }), wavelength_um: null, astrometry_code: null }];
  const app = loadApp({ fetch: backend({ frame }).fetch });
  await search(app);
  await load(app);
  const details = app.$("frame-details").textContent;
  assert.match(details, /Target wavelength: unavailable/);
  assert.match(details, /FINAST code: not supplied/);
  assert.match(details, /Pixels from: IRSA cutout service/);
});

test("P1: if some cutouts fail, the rest still load and the failures are reported", async () => {
  const frame = (id) => (id === "4" ? [502, { error: "IRSA is unavailable." }] : [200, frameBody(id)]);
  const app = loadApp({ fetch: backend({ frame }).fetch });
  await search(app);
  await load(app);
  assert.match(app.$("status").textContent, /^1\/2 frames loaded in \d+\.\d s\. .*IRSA is unavailable\./);
  assert.ok(app.$("status").classList.contains("error"));
  assert.equal(app.$("play").disabled, true, "one frame cannot be played");
});

test("P1: if every cutout fails, no image is shown and the viewer stays empty", async () => {
  const app = loadApp({ fetch: backend({ frame: () => [422, { error: "no usable cutout" }] }).fetch });
  await search(app);
  await load(app);
  assert.match(app.$("status").textContent, /^0\/2 frames loaded/);
  assert.equal(app.$("sky").style.display, "none");
  assert.equal(app.$("empty-state").hidden, false);
});

test("P1: results from a superseded load are discarded", async () => {
  let release;
  const frame = (id) => new Promise((r) => { release = () => r([200, frameBody(id)]); });
  const app = loadApp({ fetch: backend({ frame }).fetch });
  await search(app);
  app.viewer.state.selected = new Set(["0"]);
  click(app.w, app.$("load"));
  await until(() => release, "frame request");
  app.viewer.state.generation++; // a newer search started
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(app.viewer.state.frames.length, 0);
});

test("O2/UI: loading with nothing selected does nothing", async () => {
  const fake = backend({ records: [rec(0)] });
  const app = loadApp({ fetch: fake.fetch });
  await search(app);
  app.viewer.state.selected.clear();
  await app.viewer.loadFrames();
  assert.equal(fake.calls.filter((u) => u.startsWith("/api/frame")).length, 0);
});

// ------------------------------------------------------------- O2 playback

test("O2: time-sequence playback steps through frames like a video and can be paused", async () => {
  const records = [rec(0, { mjd: 60900 }), rec(1, { mjd: 60950 }), rec(2, { mjd: 61000 })];
  const app = loadApp({ fetch: backend({ records }).fetch });
  await search(app);
  app.viewer.state.selected = new Set(["0", "1", "2"]);
  await load(app);
  change(app, "mode", "sequence");
  app.$("speed").innerHTML += '<option value="5">fast</option>';
  change(app, "speed", "5");
  click(app.w, app.$("play"));
  assert.equal(app.$("play").textContent, "Pause");
  const seen = new Set();
  await until(() => { seen.add(app.viewer.state.current); return seen.size === 3; }, "all frames shown");
  click(app.w, app.$("play"));
  assert.equal(app.$("play").textContent, "Play");
  assert.equal(app.viewer.state.timer, null);
});

test("O2: blink alternates the pinned A and B frames; prev/next and the slider inspect frames", async () => {
  const records = [rec(0, { mjd: 60900 }), rec(1, { mjd: 60950 }), rec(2, { mjd: 61000 })];
  const app = loadApp({ fetch: backend({ records }).fetch });
  await search(app);
  app.viewer.state.selected = new Set(["0", "1", "2"]);
  await load(app);
  assert.equal(app.$("mode").value, "blink");
  click(app.w, app.$("next"));
  assert.equal(app.viewer.state.current, 2, "blink jumps A -> B");
  click(app.w, app.$("prev"));
  assert.equal(app.viewer.state.current, 0, "and back");
  change(app, "mode", "sequence");
  click(app.w, app.$("prev"));
  assert.equal(app.viewer.state.current, 2, "sequence wraps backwards");
  click(app.w, app.$("next"));
  assert.equal(app.viewer.state.current, 0);
  app.$("timeline").value = "1";
  app.$("timeline").dispatchEvent(new app.w.Event("input"));
  assert.equal(app.viewer.state.current, 1);
  assert.match(app.$("frame-details").textContent, /^Frame 2\/3/);
  // Pin the middle frame as B via the log, then blink between frame 1 and 2.
  const pinB = [...app.$("records").querySelectorAll("button")].filter((b) => b.textContent === "B")[1];
  click(app.w, pinB);
  assert.equal(app.viewer.state.b, 1);
  const pinA = [...app.$("records").querySelectorAll("button")].filter((b) => b.textContent === "A")[1];
  click(app.w, pinA);
  change(app, "mode", "blink");
  click(app.w, app.$("play"));
  assert.match(app.$("status").textContent, /Pin different loaded frames as A and B/, "A and B are now the same frame");
});

test("O2: the shared stretch rejects invalid limits and Auto restores it", async () => {
  const app = loadApp({ fetch: backend().fetch });
  await search(app);
  await load(app);
  app.$("high").value = String(Number(app.$("low").value) - 1);
  change(app, "high");
  assert.match(app.$("status").textContent, /Stretch high must be greater than low/);
  click(app.w, app.$("reset-stretch"));
  assert.match(app.$("status").textContent, /Shared stretch reset/);
  assert.ok(Number(app.$("high").value) > Number(app.$("low").value));
});

test("O2: a flat image still gets a valid stretch, and step/draw are no-ops before loading", async () => {
  const app = loadApp({ fetch: backend({ frame: (id) => [200, frameBody(id, { size: 1 })] }).fetch });
  app.viewer.step(1);
  app.viewer.draw();
  assert.notEqual(app.$("sky").style.display, "block", "no image is shown before frames load");
  assert.equal(app.$("empty-state").hidden, false);
  await search(app);
  await load(app);
  assert.equal(Number(app.$("high").value), Number(app.$("low").value) + 1);
});

test("UI: UI text uses correct singular/plural wording for one exposure, date and frame", async () => {
  const app = loadApp({ fetch: backend({ records: [rec(0)] }).fetch });
  await search(app);
  assert.match(app.$("status").textContent, /^Found 1 overlapping exposure\. /);
  assert.equal(app.$("selection-summary").textContent, "1 exposure / 1 calendar date / 1 selected");
  await load(app);
  assert.match(app.$("status").textContent, /^1 aligned frame ready in /);
});

// ------------------------------------------------------------- P3 Gaia overlay

const VIZIER = "https://vizier.cfa.harvard.edu/viz-bin/asu-tsv";
// One Gaia source at the Barnard field center, with zero proper motion so it stays in view.
const GAIA_ROWS = "#Table\tI_355_gaiadr3:\n_r\tSource\tRA_ICRS\tDE_ICRS\tpmRA\tpmDE\n0.00\t111\t269.446268\t4.768204\t0\t0\n";

// Routes VizieR URLs to a fake catalog and everything else to the fake /api backend.
function withVizier(fake, body = GAIA_ROWS) {
  const vizier = [];
  const fetch = async (url, init) => {
    if (url.startsWith(VIZIER)) { vizier.push(url); return { ok: true, status: 200, text: async () => body }; }
    return fake.fetch(url, init);
  };
  return { fetch, calls: fake.calls, vizier };
}

test("P3: no request on page load, even when a shared link restores gaia=1", async () => {
  const requests = [];
  const app = loadApp({
    url: "http://localhost:8000/?ra=269.446268&dec=4.768204&fov=3&release=both&deep=0&gaia=1",
    fetch: async (url) => { requests.push(url); throw new Error("no request expected on page load"); },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(requests, [], "neither /api nor VizieR is contacted");
  assert.equal(app.$("gaia-toggle").checked, true, "the toggle is restored");
  assert.equal(app.$("gaia-panel").hidden, false);
  assert.equal(app.$("gaia-status").textContent, "Gaia not queried yet. Search a field first.");
  assert.equal(app.$("gaia-action").hidden, false);
  assert.equal(app.$("gaia-action").textContent, "Query Gaia");
  assert.equal(app.$("gaia-overlay").querySelectorAll("circle").length, 0);
  assert.equal(app.$("fov").value, "3", "the other shared parameters still prefill the form");
  assert.equal(app.$("release").value, "both");

  const plain = loadApp({ url: "http://localhost:8000/?ra=1&dec=2", fetch: async (url) => { requests.push(url); } });
  assert.equal(plain.$("gaia-toggle").checked, false, "the overlay is off by default");
  assert.equal(plain.$("gaia-panel").hidden, true);
  assert.deepEqual(requests, []);
});

test("P3: a search with gaia=1 waits for Query Gaia, shares gaia=1, and a new search does not re-query", async () => {
  let center = {};
  const fake = withVizier(fakeFetch({
    search: () => [200, searchBody(barnardRecords(), undefined, center)],
    frame: (id) => [200, frameBody(id)],
  }));
  const app = loadApp({ url: "http://localhost:8000/?gaia=1", fetch: fake.fetch });
  await search(app);
  assert.equal(fake.vizier.length, 0, "the search itself does not query Gaia");
  assert.equal(app.$("gaia-status").textContent, "Gaia not queried yet.");
  assert.equal(new URL(app.w.location.href).searchParams.get("gaia"), "1");
  assert.equal(new URLSearchParams(fake.calls[0].split("?")[1]).has("gaia"), false, "gaia is not sent to /api/search");

  click(app.w, app.$("gaia-action"));
  await until(() => /^1 Gaia DR3 source in the query cone\.$/.test(app.$("gaia-status").textContent), "Gaia result");
  assert.equal(fake.vizier.length, 1);
  await load(app);
  assert.equal(app.$("gaia-overlay").querySelectorAll("circle").length, 1, "a marker is drawn once a frame is displayed");
  assert.match(app.$("gaia-provenance").textContent,
    /^Gaia DR3 \(I\/355\/gaiadr3\), queried via VizieR ASU on \d{4}-\d{2}-\d{2} UTC, linear proper-motion propagation to \d{4}-\d{2}-\d{2} \(\d{4}\.\d{3}\)\.$/);

  center = { ra: 270, dec: 5 }; // a different field
  await search(app);
  assert.equal(fake.vizier.length, 1, "a new search does not query again by itself");
  assert.equal(app.$("gaia-status").textContent, "Gaia not queried yet.");
  assert.equal(app.$("gaia-overlay").querySelectorAll("circle").length, 0);

  center = {}; // back to the first field: shown from cache, still no request
  await search(app);
  assert.equal(fake.vizier.length, 1);
  assert.match(app.$("gaia-status").textContent, /^1 Gaia DR3 source in the query cone\./);
});
