"use strict";
// The assistant's entry point says it helps with both the sky and the app. Tag: UI.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const html = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf8");

test("UI: the Ask button and drawer advertise help with both what you see and how to use the app", () => {
  assert.match(html, /class="assistant-fab"[^>]*>Ask SpaceLapse</);
  assert.match(html, /id="assistantTitle">ASK SPACELAPSE</);
  assert.match(html, /what you are seeing or how to use the app/);
  assert.match(html, /placeholder="[^"]*What am I looking at?[^"]*How do I compare two dates?/);
});
