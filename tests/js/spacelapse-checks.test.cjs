"use strict";
// SpaceLapse app integration (see spacelapse-app.cjs). Tags: O3 challenge targets, P1 Person 1.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSpaceLapse, until } = require("./spacelapse-app.cjs");

test("O3/P1: 'Run five target checks' checks all five challenge targets against the index", async () => {
  const w = await loadSpaceLapse("");
  const $ = (id) => w.document.getElementById(id);
  $("runChecks").click();
  await until(() => /Finished: 5 of 5/.test($("runChecks").closest("details").textContent), 60000);
  const text = $("runChecks").closest("details").textContent;
  assert.doesNotMatch(text, /is not defined|TypeError/, "checks must run, not crash");
  for (const name of ["Barnard's Star", "Epsilon Indi B", "WISE 0855", "RW Aurigae", "R Draconis"]) {
    assert.match(text, new RegExp(`${name}:`), `${name} reported`);
  }
  assert.equal($("exportChecks").disabled, false, "results can be exported");
});
