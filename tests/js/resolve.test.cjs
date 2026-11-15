"use strict";
// Name lookup: an unknown name is "not found"; an unreachable service is "could not check". Tag: O1/P1.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { JSDOM } = require("jsdom");

globalThis.DOMParser = new JSDOM("").window.DOMParser;
const { pathToFileURL } = require("node:url");
const load = () => import(pathToFileURL(path.resolve(__dirname, "../../js/resolve.js")).href);
const reply = (status, body) => async () => ({ ok: status < 400, status, text: async () => body });

test("O1: a known name resolves to coordinates", async () => {
  const { resolve } = await load();
  globalThis.fetch = reply(200, "<Sesame><Target><Resolver><jradeg>83.82</jradeg><jdedeg>-5.39</jdedeg></Resolver></Target></Sesame>");
  assert.deepEqual(await resolve("M42"), { ra: 83.82, dec: -5.39, name: "M42" });
});

test("O1/P1: an unknown name is reported as not found", async () => {
  const { resolve } = await load();
  globalThis.fetch = reply(200, "<Sesame><Target><INFO>nothing found</INFO></Target></Sesame>");
  await assert.rejects(resolve("Planet X"), /^Error: Couldn't find "Planet X"/);
});

test("P1: a name-service error page is 'could not check', never 'not found'", async () => {
  const { resolve } = await load();
  globalThis.fetch = reply(503, "<html>Service unavailable</html>");
  await assert.rejects(resolve("M42"), (e) => /could not be checked/.test(e.message) && !/Couldn't find/.test(e.message));
});

test("P1: a network failure is 'could not check', with coordinates as the fallback", async () => {
  const { resolve } = await load();
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(resolve("M42"), /could not be checked.*enter RA Dec/);
});

test("cancelling a lookup still cancels", async () => {
  const { resolve } = await load();
  globalThis.fetch = async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); };
  await assert.rejects(resolve("M42"), { name: "AbortError" });
});

test("O1: coordinates skip the name service entirely", async () => {
  const { resolve } = await load();
  globalThis.fetch = async () => { throw new Error("should not be called"); };
  assert.deepEqual(await resolve("83.82 -5.39"), { ra: 83.82, dec: -5.39, name: null });
});
