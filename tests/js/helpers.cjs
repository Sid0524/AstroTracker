"use strict";
// Loads index.html in jsdom with the real scripts and a fake /api backend.

const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..", "..");
const HTML = fs.readFileSync(path.join(ROOT, "static", "index.html"), "utf8")
  .replace(/<script[^>]*><\/script>/g, ""); // scripts are loaded by require() below
const TIMELINE = path.join(ROOT, "static", "timeline.js");
const VIEWER = path.join(ROOT, "static", "viewer.js");
const BANDS = ["SPHEREx-D1", "SPHEREx-D2", "SPHEREx-D3", "SPHEREx-D4", "SPHEREx-D5", "SPHEREx-D6"];
const MJD_UNIX_EPOCH = 40587;

function isoFromMjd(mjd) {
  return new Date((mjd - MJD_UNIX_EPOCH) * 86400000).toISOString().slice(0, 19) + "Z";
}

// One exposure record shaped like /api/search output.
function rec(id, { mjd = 60914.2, band = "SPHEREx-D1", collection = "spherex_dr1", range = [0.75, 1.09] } = {}) {
  return {
    id: String(id), mjd, date: isoFromMjd(mjd), band, collection,
    release: collection.split("_")[1].toUpperCase(), observation: `obs${id}`,
    range_um: range, cutout_url: `https://irsa.ipac.caltech.edu/ibe/data/spherex/x/${id}.fits?center=1,2&size=0.1`,
  };
}

function searchBody(records, statuses, extra = {}) {
  const collection_status = statuses ?? [...new Set(records.map((r) => r.collection))]
    .map((c) => ({ collection: c, status: "ok", count: records.filter((r) => r.collection === c).length, skipped: 0, message: "ok" }));
  return { search_id: "S1", records, warnings: [], collections: collection_status.map((s) => s.collection),
    collection_status, ra: 269.446268, dec: 4.768204, fov_arcmin: 3, ...extra };
}

function frameBody(id, { source = "s3", value = 1, wavelength = 1.0, size = 4 } = {}) {
  const pixels = new Float32Array(size * size).map((_, i) => value + i);
  if (size > 1) pixels[1] = NaN; // one missing pixel, drawn as the "no data" colour
  return { id: String(id), size, pixels: Buffer.from(pixels.buffer).toString("base64"), coverage: 99.5,
    center_covered: true, wavelength_um: wavelength, bandwidth_um: 0.02, flagged_percent: 12.5,
    astrometry_code: 0, unit: "MJy/sr", source };
}

// A controllable fake backend. handlers: { search(url) -> [status, body], frame(id, url) -> [status, body] | Promise }
function fakeFetch(handlers) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    let result;
    if (url.startsWith("/api/search")) result = await handlers.search(url);
    else {
      const id = url.split("/").pop();
      result = await handlers.frame(id, url);
    }
    const [status, body] = result;
    return { ok: status < 400, status, json: async () => body };
  };
  return { fetch, calls };
}

function loadApp({ url = "http://localhost:8000/", fetch } = {}) {
  const dom = new JSDOM(HTML, { url, pretendToBeVisual: true });
  const w = dom.window;
  w.HTMLCanvasElement.prototype.getContext = function () {
    return { createImageData: (a, b) => ({ data: new Uint8ClampedArray(a * b * 4) }), putImageData: () => {} };
  };
  Object.assign(globalThis, {
    window: w, document: w.document, history: w.history, location: w.location, Option: w.Option,
    FormData: w.FormData, Event: w.Event, fetch: fetch ?? (async () => { throw new Error("no backend"); }),
  });
  delete require.cache[TIMELINE];
  delete require.cache[VIEWER];
  globalThis.ObservationTimeline = require(TIMELINE);
  const viewer = require(VIEWER);
  const $ = (id) => w.document.getElementById(id);
  return { dom, w, doc: w.document, viewer, $, timeline: globalThis.ObservationTimeline };
}

async function until(predicate, label = "condition", ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function click(w, el) { el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); }
function key(w, el, k) { el.dispatchEvent(new w.KeyboardEvent("keydown", { key: k, bubbles: true })); }

// Runs a search through the real form and waits for the UI to settle.
async function search(app) {
  click(app.w, app.$("search-button"));
  await until(() => !app.viewer.state.busy && app.viewer.state.search !== null || app.$("status").classList.contains("error"), "search");
}

async function load(app) {
  click(app.w, app.$("load"));
  await until(() => /frames? (ready|loaded)/.test(app.$("status").textContent), "frames");
}

module.exports = { ROOT, BANDS, rec, searchBody, frameBody, fakeFetch, loadApp, until, click, key, search, load, isoFromMjd };
