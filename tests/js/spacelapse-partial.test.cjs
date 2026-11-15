"use strict";
// SpaceLapse app integration (see spacelapse-app.cjs). Tags: O1/O3 objectives, P1 Person 1.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT, loadSpaceLapse, indexFetch, until } = require("./spacelapse-app.cjs");

test("P1: if some index tiles fail, results still show with a coverage-incomplete warning", async () => {
  let first = true;
  const fetch = indexFetch(null, async (url) => {
    if (first) { first = false; return { ok: false, status: 503 }; }
    const buf = fs.readFileSync(path.join(ROOT, url));
    return { ok: true, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  });
  const w = await loadSpaceLapse("#ra=269.446268&dec=4.768204&name=Barnard", fetch);
  const $ = (id) => w.document.getElementById(id);
  await until(() => !$("coverageWarning").hidden);
  assert.match($("coverageWarning").textContent, /^Coverage incomplete: 1 of \d+ index tiles failed to load/);
  assert.ok([...w.document.querySelectorAll(".toast")].some((t) => /Coverage incomplete/.test(t.textContent)));
});
