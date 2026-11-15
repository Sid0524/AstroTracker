"use strict";
// SpaceLapse app integration (see spacelapse-app.cjs). Tag: P1 no data vs could not confirm.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSpaceLapse, indexFetch, until } = require("./spacelapse-app.cjs");

test("P1: a moving object with no indexed exposures gets an index-scoped message", async () => {
  const w = await loadSpaceLapse("#track=3I%2FATLAS", indexFetch((ix) => { ix.tiles = {}; }));
  await until(() => w.document.querySelector(".toast"), 15000);
  const text = w.document.querySelector(".toast").textContent;
  assert.match(text, /^No SPHEREx exposures of 3I\/ATLAS along its path in the index \(searched /);
  assert.doesNotMatch(text, /hasn.t released/);
});
