"use strict";
// SpaceLapse app integration (see spacelapse-app.cjs). Tag: P1 no data vs could not confirm.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSpaceLapse, indexFetch, until } = require("./spacelapse-app.cjs");

test("P1: a moving-object search whose index tiles all fail reports unknown coverage", async () => {
  const w = await loadSpaceLapse("#track=3I%2FATLAS", indexFetch(null, async () => ({ ok: false, status: 503 })));
  await until(() => w.document.querySelector(".toast"), 15000);
  assert.match(w.document.querySelector(".toast").textContent, /coverage is unknown/);
});
