"use strict";
// SpaceLapse app integration (see spacelapse-app.cjs). Tags: O1/O3 objectives, P1 Person 1.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT, loadSpaceLapse, indexFetch, until } = require("./spacelapse-app.cjs");

test("P1: if every index tile fails, the search reports unknown coverage", async () => {
  const w = await loadSpaceLapse("#ra=269.446268&dec=4.768204&name=Barnard", indexFetch(null, async () => ({ ok: false, status: 500 })));
  await until(() => w.document.querySelector(".toast"));
  assert.match(w.document.querySelector(".toast").textContent, /coverage is unknown/);
  assert.equal(w.document.querySelectorAll(".cov-mark").length, 0);
});
