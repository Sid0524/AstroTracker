"use strict";
// SpaceLapse app integration (see spacelapse-app.cjs). Tags: O1/O3 objectives, P1 Person 1.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT, loadSpaceLapse, indexFetch, until } = require("./spacelapse-app.cjs");

test("O1/O3/P1: a Barnard's Star coordinate link shows coverage by detector and release, with index scope", async () => {
  const w = await loadSpaceLapse("#ra=269.446268&dec=4.768204&name=Barnard%27s%20Star");
  const $ = (id) => w.document.getElementById(id);
  await until(() => w.document.querySelector(".cov-mark"));
  assert.equal($("coverageSection").hidden, false);
  assert.equal(w.document.querySelectorAll(".cov-row").length, 6);
  const releases = new Set([...w.document.querySelectorAll(".cov-mark")].map((m) => m.className.split(" ")[1]));
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "index.json")));
  const indexed = new Set(index.folders.map((f) => `rel-${f.split("/")[0]}`));
  for (const r of releases) assert.ok(indexed.has(r), `${r} is an indexed release`);
  assert.match($("coverageSummary").textContent, /exposures on \d+ UTC dates in \d+ survey windows/);
  assert.match($("coverageSummary").textContent, new RegExp(`index updated ${index.updated.slice(0, 10)}`));
  assert.equal($("coverageWarning").hidden, true);
  // Click a mark in another detector: the app switches detector.
  const other = [...w.document.querySelectorAll(".cov-row")].find((r) => !r.classList.contains("active") && r.querySelector(".cov-mark"));
  other.querySelector(".cov-mark").click();
  await until(() => other.classList.contains("active") || w.document.querySelector(".cov-row.active .cov-label")?.textContent === other.querySelector(".cov-label").textContent);
  assert.equal(w.document.querySelector(".band[aria-pressed=true]").textContent, other.querySelector(".cov-label").textContent);
});
