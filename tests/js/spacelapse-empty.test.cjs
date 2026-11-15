"use strict";
// SpaceLapse app integration (see spacelapse-app.cjs). Tags: O1/O3 objectives, P1 Person 1.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT, loadSpaceLapse, indexFetch, until } = require("./spacelapse-app.cjs");

test("P1: an uncovered position says which releases were searched, not that SPHEREx has no images", async () => {
  const w = await loadSpaceLapse("#ra=10&dec=10&name=Empty", indexFetch((ix) => { ix.tiles = {}; }));
  const $ = (id) => w.document.getElementById(id);
  await until(() => w.document.querySelector(".toast"));
  const toast = w.document.querySelector(".toast").textContent;
  assert.match(toast, /^No SPHEREx exposures of this position in the index \(searched /);
  assert.doesNotMatch(toast, /hasn.t released/);
  assert.equal($("coverageSection").hidden, false);
  assert.equal($("coverageSummary").textContent, toast);
  assert.equal(w.document.querySelectorAll(".cov-mark").length, 0);
});
