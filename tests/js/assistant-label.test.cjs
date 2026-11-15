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

test("UI: the question box's focus ring has room and does not cover the text above it", () => {
  const css = fs.readFileSync(path.resolve(__dirname, "../../css/style.css"), "utf8");
  const form = css.match(/\.assistant-form \{[^}]*\}/)[0];
  const ring = css.match(/\.assistant-form textarea:focus-visible \{[^}]*\}/);
  const gap = Number((form.match(/margin-top:\s*(\d+)px/) || [])[1] || 0);
  const offset = Number((ring?.[0].match(/outline-offset:\s*(\d+)px/) || [])[1] ?? 3);
  assert.ok(ring, "the question box has its own focus style");
  assert.match(ring[0], /outline:\s*2px solid/, "keyboard users still see a clear ring");
  assert.ok(gap >= offset + 2 + 4, `gap ${gap}px must exceed the ring's reach (${offset}px offset + 2px width) plus spacing`);
});
