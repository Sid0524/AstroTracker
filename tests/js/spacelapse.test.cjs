"use strict";
// SpaceLapse coverage chart (js/coverage.js) and its wiring in js/app.js, in jsdom.
// Tags: O1 RA/Dec search, O3 challenge targets, P1 timeline + coverage honesty.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..", "..");
const coverage = () => import(path.join(ROOT, "js", "coverage.js").replace(/\\/g, "/").replace(/^/, "file:///"));

const DETECTORS = { 1: { name: "D1" }, 2: { name: "D2" }, 3: { name: "D3" }, 4: { name: "D4" }, 5: { name: "D5" }, 6: { name: "D6" } };
const exp = (mjd, detector = 1, release = "qr2") => ({ id: `x${mjd}`, detector, mjd, date: new Date((mjd - 40587) * 864e5), release });

test("P1: chart draws six detector rows, one mark per detector/day/release, and survey windows", async () => {
  const { renderCoverage } = await coverage();
  const { document } = new JSDOM("<div id=c></div>").window;
  const root = document.getElementById("c");
  renderCoverage(root, { exposures: [exp(60900), exp(60900.2), exp(60901, 3, "qr3"), exp(61100, 6, "dr1")], band: 3, detectors: DETECTORS });
  const rows = [...root.querySelectorAll(".cov-row")];
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map((r) => r.querySelector(".cov-label").textContent), ["D1", "D2", "D3", "D4", "D5", "D6"]);
  assert.ok(rows[2].classList.contains("active"), "selected detector highlighted");
  const marks = [...root.querySelectorAll(".cov-mark")];
  assert.equal(marks.length, 3);
  assert.deepEqual(marks.map((m) => m.className), ["cov-mark rel-qr2", "cov-mark rel-qr3", "cov-mark rel-dr1"]);
  assert.match(marks[0].getAttribute("aria-label"), /^2025-08-13, D1, QR2: 2 exposures\. Show this date\.$/);
  assert.equal(marks[0].tagName, "BUTTON", "native buttons: keyboard Enter/Space work");
  assert.equal(rows[0].querySelectorAll(".cov-window").length, 2, "two survey windows");
  assert.ok(Number.parseFloat(marks[2].style.left) > Number.parseFloat(marks[0].style.left), "positioned by time");
});

test("P1/UI: clicking a mark reports its detector and date; no handler is safe", async () => {
  const { renderCoverage } = await coverage();
  const { document } = new JSDOM("<div id=c></div>").window;
  const root = document.getElementById("c");
  const picks = [];
  renderCoverage(root, { exposures: [exp(60900, 4)], band: 1, onPick: (d, m) => picks.push([d, m]) });
  root.querySelector(".cov-mark").click();
  assert.deepEqual(picks, [[4, 60900]]);
  assert.equal(root.querySelector(".cov-label").textContent, "D1", "falls back to D<n> without detector names");
  renderCoverage(root, { exposures: [exp(60900)], band: 1 });
  root.querySelector(".cov-mark").click(); // must not throw
});

test("P1: no exposures clears the chart", async () => {
  const { renderCoverage } = await coverage();
  const { document } = new JSDOM("<div id=c><p>old</p></div>").window;
  const root = document.getElementById("c");
  renderCoverage(root, { exposures: [], band: 1 });
  assert.equal(root.children.length, 0);
});
