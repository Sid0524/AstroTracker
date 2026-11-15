"use strict";
// SpaceLapse app integration (see spacelapse-app.cjs). Tag: P1 no data vs could not confirm.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSpaceLapse, indexFetch, until } = require("./spacelapse-app.cjs");

test("P1: when every image download fails, the app says it could not confirm, not 'no data'", async () => {
  const w = await loadSpaceLapse("#ra=269.446268&dec=4.768204&name=Barnard&maxFrames=4"); // image downloads are offline here
  const toasts = () => [...w.document.querySelectorAll(".toast")].map((t) => t.textContent);
  await until(() => toasts().some((t) => /could not be downloaded/.test(t)), 30000);
  const text = toasts().find((t) => /could not be downloaded/.test(t));
  assert.match(text, /not confirmed as missing data/);
  assert.ok(!toasts().some((t) => /No usable cutouts/.test(t)), "never claims there are no usable cutouts");
});
