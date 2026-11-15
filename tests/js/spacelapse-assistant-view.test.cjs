"use strict";
// The view summary sent to the assistant includes UI state (Person 1 context + #1 guidance).
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSpaceLapse, until } = require("./spacelapse-app.cjs");

test("UI: the assistant receives the target, detector, mode, loading state and open panels", async () => {
  const w = await loadSpaceLapse("#ra=269.446268&dec=4.768204&name=Barnard%27s%20Star&view=blink");
  const $ = (id) => w.document.getElementById(id);
  await until(() => w.document.querySelector(".cov-mark"));
  $("qualityInspector").open = true;
  let body = null;
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { if (String(url).includes("api/ask")) { body = JSON.parse(opts.body); throw new Error("offline"); } return real(url, opts); };
  $("assistantQuestion").value = "How do I compare two dates?";
  $("assistant").querySelector("form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => body);
  const v = body.view;
  assert.equal(v.target.name, "Barnard's Star");
  assert.match(v.detector, /^D\d \(/);
  assert.equal(v.viewMode, "blink");
  assert.equal(typeof v.loading, "boolean");
  assert.ok(Array.isArray(v.openPanels) && v.openPanels.includes("Inspect image quality & source files"));
  assert.ok("blinkA" in v && "blinkB" in v, "blink dates are included in blink/compare modes");
  assert.ok(JSON.stringify(v).length < 3000, "fits the server's view cap");
});
