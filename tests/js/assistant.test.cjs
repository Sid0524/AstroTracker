"use strict";
// "Ask about this view" panel (js/assistant.js). Tags: UI, C (plain-language help).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { JSDOM } = require("jsdom");

const load = () => import(pathToFileURL(path.resolve(__dirname, "../../js/assistant.js")).href);
const HTML = `<div id=a><button type=button class="assistant-fab" aria-expanded="false" aria-controls="drawer">Ask</button><aside class="assistant-drawer" id="drawer" hidden><button type=button class="assistant-close" aria-label="Close">x</button><form><textarea></textarea><button type=submit>Ask</button></form><p class="assistant-answer"></p><p class="assistant-meta"></p></aside></div><button id=outside>other</button>`;

async function setup(respond) {
  const { initAssistant } = await load();
  const { window } = new JSDOM(HTML, { pretendToBeVisual: true });
  const root = window.document.getElementById("a");
  const sent = [];
  let release;
  const fetchImpl = async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return respond(() => new Promise(r => { release = r; })); };
  const api = initAssistant(root, { getView: () => ({ target: { name: "Barnard's Star" } }), fetchImpl });
  const $ = (s) => root.querySelector(s);
  return { window, api, sent, $, release: (v) => release(v), ask: async (q) => { $("textarea").value = q; await api.submit(); } };
}
const ok = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test("UI: sends the question with the current view and shows the answer with its model", async () => {
  const t = await setup(() => ok({ answer: "It is Barnard's Star in D1.", model: "openai:gpt-5", fallback: false }));
  await t.ask("  What is this?  ");
  assert.deepEqual(t.sent[0], { url: "api/ask", body: { question: "What is this?", view: { target: { name: "Barnard's Star" } } } });
  assert.equal(t.$(".assistant-answer").textContent, "It is Barnard's Star in D1.");
  assert.match(t.$(".assistant-meta").textContent, /^Answered by openai:gpt-5\. AI answers can be wrong/);
});

test("UI: backup-model answers are labelled as possibly less accurate", async () => {
  const t = await setup(() => ok({ answer: "Backup.", model: "openrouter:x:free", fallback: true }));
  await t.ask("Why?");
  assert.match(t.$(".assistant-meta").textContent, /openrouter:x:free \(backup model; may be less accurate\)/);
});

test("UI: answers are shown as text, never run as HTML", async () => {
  const t = await setup(() => ok({ answer: "<img src=x onerror=alert(1)>", model: "m" }));
  await t.ask("Hi");
  assert.equal(t.$(".assistant-answer").querySelector("img"), null);
  assert.equal(t.$(".assistant-answer").textContent, "<img src=x onerror=alert(1)>");
});

test("UI: server errors, unreadable replies and network failures are explained", async () => {
  for (const [respond, expected] of [
    [() => ok({ error: "Too many questions. Please wait a minute." }, 429), /Too many questions/],
    [() => ({ ok: false, status: 502, json: async () => { throw new Error("html"); } }), /unavailable right now/],
    [() => { throw new TypeError("offline"); }, /Could not reach the assistant/],
  ]) {
    const t = await setup(respond);
    await t.ask("Hi");
    assert.match(t.$(".assistant-answer").textContent, expected);
    assert.equal(t.$(".assistant-meta").textContent, "");
    assert.equal(t.$("button[type=submit]").disabled, false, "can try again");
  }
});

test("UI: empty questions are ignored; the button is disabled while waiting, so no double sends", async () => {
  const t = await setup((wait) => wait());
  await t.ask("   ");
  assert.equal(t.sent.length, 0);
  t.$("textarea").value = "First";
  const pending = t.api.submit();
  await new Promise((r) => setImmediate(r));
  assert.equal(t.$("button[type=submit]").disabled, true);
  assert.equal(t.$(".assistant-answer").textContent, "Thinking…");
  await t.api.submit();
  assert.equal(t.sent.length, 1);
  t.release(ok({ answer: "Done.", model: "m" }));
  await pending;
  assert.equal(t.$("button[type=submit]").disabled, false);
});

test("UI: Enter asks, Shift+Enter adds a new line, and the form's submit works", async () => {
  const t = await setup(() => ok({ answer: "A", model: "m" }));
  const key = (k, shiftKey = false) => t.$("textarea").dispatchEvent(new t.window.KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true }));
  t.$("textarea").value = "Q1";
  key("Enter", true);
  await new Promise((r) => setImmediate(r));
  assert.equal(t.sent.length, 0);
  key("Enter");
  await new Promise((r) => setImmediate(r));
  assert.equal(t.sent.length, 1);
  t.$("form").dispatchEvent(new t.window.Event("submit", { cancelable: true }));
  await new Promise((r) => setImmediate(r));
  assert.equal(t.sent.length, 2);
});

test("UI: the floating Ask button opens the drawer and puts the cursor in the question box", async () => {
  const t = await setup(() => ok({ answer: "A", model: "m" }));
  const fab = t.$(".assistant-fab"), drawer = t.$(".assistant-drawer");
  assert.equal(drawer.hidden, true);
  fab.click();
  assert.equal(drawer.hidden, false);
  assert.equal(fab.getAttribute("aria-expanded"), "true");
  assert.equal(t.window.document.activeElement, t.$("textarea"));
  fab.click();
  assert.equal(drawer.hidden, true, "the button toggles");
  assert.equal(fab.getAttribute("aria-expanded"), "false");
});

test("UI: the close button and Escape close the drawer and return focus to the Ask button", async () => {
  const t = await setup(() => ok({ answer: "A", model: "m" }));
  const fab = t.$(".assistant-fab"), drawer = t.$(".assistant-drawer");
  fab.click();
  t.$(".assistant-close").click();
  assert.equal(drawer.hidden, true);
  assert.equal(t.window.document.activeElement, fab);
  fab.click();
  t.$("textarea").dispatchEvent(new t.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(drawer.hidden, true);
  assert.equal(t.window.document.activeElement, fab);
});

test("UI: the last answer stays when the drawer is closed and reopened", async () => {
  const t = await setup(() => ok({ answer: "Kept answer.", model: "m" }));
  t.$(".assistant-fab").click();
  await t.ask("Q");
  t.$(".assistant-close").click();
  t.$(".assistant-fab").click();
  assert.equal(t.$(".assistant-answer").textContent, "Kept answer.");
});
