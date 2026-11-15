"use strict";
// Timeline component tests (Person 1 task 2; failed releases read as unknown, not empty).

const test = require("node:test");
const assert = require("node:assert/strict");
const { rec, loadApp, click, key } = require("./helpers.cjs");

function setup() {
  const app = loadApp();
  const root = app.$("coverage");
  const picks = [];
  const render = (search, opts = {}) => app.timeline.render(root, {
    search, band: "SPHEREx-D1", selected: new Set(), loaded: new Set(), busy: false,
    onPick: (g) => picks.push(g), ...opts,
  });
  return { app, root, picks, render, q: (s) => root.querySelector(s), qa: (s) => [...root.querySelectorAll(s)] };
}

const status = (collection, s, count = 0, skipped = 0) => ({ collection, status: s, count, skipped, message: `${collection} ${s} detail` });

test("P1: before any search it invites the user to search", () => {
  const t = setup();
  t.render(null);
  assert.match(t.q(".obs-chart").textContent, /Search a field/);
  assert.equal(t.qa(".collection-status li").length, 0);
  assert.equal(t.q(".obs-summary").textContent, "");
});

test("P1: no records with a failed release says coverage is unknown, not empty", () => {
  const t = setup();
  t.render({ records: [], collection_status: [status("spherex_dr1", "empty"), status("spherex_qr3", "failed")] });
  assert.match(t.q(".obs-chart").textContent, /coverage is unknown, not empty/);
});

test("P1: no records with every release answering says there is no coverage", () => {
  const t = setup();
  t.render({ records: [], collection_status: [status("spherex_qr3", "empty")] });
  assert.match(t.q(".obs-chart").textContent, /have no exposures of this field/);
});

test("P1: a search without collection_status (older backend) still renders", () => {
  const t = setup();
  t.render({ records: [] });
  assert.match(t.q(".obs-chart").textContent, /no exposures/);
});

test("P1: each release gets a status chip with its outcome, colour class and full message", () => {
  const t = setup();
  t.render({ records: [rec(0)], collection_status: [
    status("spherex_dr1", "ok", 252), status("spherex_qr3", "empty"),
    status("spherex_dr1_deep", "partial", 5, 2), status("spherex_qr3_deep", "truncated", 1500),
    status("spherex_dr1", "failed"), { collection: "spherex_qr3", status: "mystery", count: 0, skipped: 0, message: "?" },
  ] });
  const chips = t.qa(".collection-status li");
  assert.deepEqual(chips.map((c) => c.className), ["status-ok", "status-empty", "status-partial", "status-truncated", "status-failed", "status-mystery"]);
  assert.match(chips[0].textContent, /DR1 252 exposures/);
  assert.match(chips[1].textContent, /QR3 searched: no exposures here/);
  assert.match(chips[2].textContent, /DR1 deep 5 exposures, 2 unreadable rows skipped/);
  assert.match(chips[3].textContent, /list capped, later dates may be missing/);
  assert.match(chips[4].textContent, /query failed: coverage unknown/);
  assert.match(chips[5].textContent, /mystery/, "unknown statuses are shown verbatim");
  assert.equal(chips[4].title, "spherex_dr1 failed detail");
  assert.ok(chips[2].querySelector(".swatch.dr1.deep"));
  assert.ok(chips[1].querySelector(".swatch.qr3"));
});

test("P1: one mark per detector, UTC day and release, in the detector's row", () => {
  const t = setup();
  const records = [
    rec(0, { mjd: 60914.2 }), rec(1, { mjd: 60914.3 }),                       // same day, same band -> one mark
    rec(2, { mjd: 60914.2, band: "SPHEREx-D6" }),                              // other detector
    rec(3, { mjd: 61240.1, collection: "spherex_qr3" }),                       // other release, months later
    rec(4, { mjd: 60915.2, collection: "spherex_dr1_deep" }),                  // deep survey
    rec(5, { mjd: 60916.2, band: "SPHEREx-D9" }),                              // unknown detector: not drawn
  ];
  t.render({ records, collection_status: [] });
  const marks = t.qa(".obs-mark");
  assert.equal(marks.length, 4);
  const labels = marks.map((m) => m.getAttribute("aria-label"));
  assert.ok(labels.some((l) => /D1, DR1: 2 exposures, 0\.75-1\.09 um/.test(l)));
  assert.ok(labels.some((l) => /D6, DR1: 1 exposure,/.test(l)));
  assert.ok(marks.some((m) => m.classList.contains("qr3")));
  assert.ok(marks.some((m) => m.classList.contains("deep")));
  assert.equal(t.qa(".obs-band").length, 6, "all six detectors have a row");
});

test("P1/UI: the selected detector row and selected/loaded exposures are highlighted", () => {
  const t = setup();
  t.render({ records: [rec(0), rec(1, { mjd: 60940.2 })], collection_status: [] },
    { band: "SPHEREx-D1", selected: new Set(["0"]), loaded: new Set(["0"]) });
  assert.equal(t.qa(".obs-row.active").length, 1);
  assert.match(t.q(".obs-band.active").textContent, /^D1/);
  const [first, second] = t.qa(".obs-mark");
  assert.ok(first.classList.contains("selected"));
  assert.equal(first.getAttribute("aria-pressed"), "true");
  assert.match(first.getAttribute("aria-label"), /selected, loaded\. Activate to deselect/);
  assert.ok(first.querySelector(".obs-loaded"));
  assert.equal(second.getAttribute("aria-pressed"), "false");
  assert.equal(second.querySelector(".obs-loaded"), null);
});

test("P1: survey windows group dates closer than 30 days and are labelled", () => {
  const t = setup();
  const records = [];
  for (let i = 0; i < 20; i++) records.push(rec(i, { mjd: 60900 + i * 2 }));       // window 1: 39 days
  for (let i = 0; i < 20; i++) records.push(rec(100 + i, { mjd: 61080 + i * 2 })); // window 2
  t.render({ records, collection_status: [] });
  assert.equal(t.qa(".obs-window").length, 2);
  assert.match(t.q(".obs-window-label").textContent, /39 d \/ 20 exp/);
  assert.match(t.q(".obs-summary").textContent, /40 exposures on 40 UTC dates in 2 survey windows/);
  assert.equal(t.app.timeline.surveyWindows(records).length, 2);
});

test("UI: month ticks are thinned so labels do not collide on a long baseline", () => {
  const t = setup();
  t.render({ records: [rec(0, { mjd: 58000 }), rec(1, { mjd: 61000 })], collection_status: [] });
  const labels = t.qa(".obs-axis").map((l) => l.textContent);
  assert.ok(labels.length < t.qa(".obs-grid").length, "fewer labels than gridlines");
  assert.match(labels[0], /^\d{4}-\d{2}$/);
});

test("UI: a single-date search still gets a readable axis and singular wording", () => {
  const t = setup();
  t.render({ records: [rec(0)], collection_status: [] }, { band: null });
  assert.match(t.q(".obs-summary").textContent, /1 exposure on 1 UTC date in 1 survey window,/);
  assert.doesNotMatch(t.q(".obs-summary").textContent, / has \d+ date/, "no band sentence without a band");
  assert.equal(t.qa(".obs-window-label").length, 0, "too narrow to label");
});

test("P1/UI: clicking or pressing Enter/Space on a mark picks that group", () => {
  const t = setup();
  t.render({ records: [rec(0), rec(1, { mjd: 60914.25 })], collection_status: [] });
  const mark = t.q(".obs-mark");
  click(t.app.w, mark);
  key(t.app.w, mark, "Enter");
  key(t.app.w, mark, " ");
  key(t.app.w, mark, "Tab"); // ignored
  assert.equal(t.picks.length, 3);
  assert.equal(t.picks[0].band, "SPHEREx-D1");
  assert.deepEqual(t.picks[0].records.map((r) => r.id), ["0", "1"], "exposures sorted by time");
  assert.equal(mark.getAttribute("tabindex"), "0");
  assert.equal(mark.getAttribute("role"), "button");
});

test("UI: while loading, marks are inert and leave the tab order", () => {
  const t = setup();
  t.render({ records: [rec(0)], collection_status: [] }, { busy: true });
  const mark = t.q(".obs-mark");
  click(t.app.w, mark);
  assert.equal(t.picks.length, 0);
  assert.equal(mark.getAttribute("tabindex"), "-1");
  assert.ok(mark.classList.contains("busy"));
});

test("P1: groupRecords keys by band, UTC day and collection and sorts chronologically", () => {
  const t = setup();
  const groups = t.app.timeline.groupRecords([rec(0, { mjd: 60920 }), rec(1, { mjd: 60910 }), rec(2, { mjd: 60910.1 })]);
  assert.deepEqual(groups.map((g) => g.records.length), [2, 1]);
  assert.ok(groups[0].mjd < groups[1].mjd);
  assert.match(groups[0].key, /^SPHEREx-D1\|\d{4}-\d{2}-\d{2}\|spherex_dr1$/);
});

test("UI: the legend explains every visual encoding", () => {
  const t = setup();
  const legend = t.q(".obs-legend").textContent;
  for (const word of ["DR1", "QR3", "Deep survey", "Selected", "Loaded", "Survey window"]) assert.match(legend, new RegExp(word));
});

test("UI: status chips use singular wording for one exposure and one skipped row", () => {
  const t = setup();
  t.render({ records: [rec(0)], collection_status: [status("spherex_dr1", "ok", 1), status("spherex_qr3", "partial", 1, 1)] });
  const chips = t.qa(".collection-status li").map((c) => c.textContent);
  assert.match(chips[0], /DR1 1 exposure$/);
  assert.match(chips[1], /QR3 1 exposure, 1 unreadable row skipped$/);
});
