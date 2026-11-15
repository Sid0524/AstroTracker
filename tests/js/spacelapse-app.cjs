"use strict";
// Loads the real SpaceLapse page and js/app.js in jsdom. One app per process:
// catalog.js caches the index and tiles at module level.
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const ROOT = path.resolve(__dirname, "..", "..");

async function loadSpaceLapse(hash, fetchOverride) {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8").replace(/<script[^>]*src=[^>]*><\/script>/g, "");
  const dom = new JSDOM(html, { url: `http://localhost/${hash}`, pretendToBeVisual: true });
  const w = dom.window;
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (_, k) => (k === "createImageData" ? (a, b) => ({ data: new Uint8ClampedArray(a * b * 4), width: a, height: b }) : k === "getImageData" ? () => ({ data: new Uint8ClampedArray(4) }) : () => {}) });
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.scrollTo = () => {};
  const realFetch = async (url) => {
    const file = path.join(ROOT, url.split("?")[0]);
    if (url.startsWith("data/") && fs.existsSync(file)) {
      const buf = fs.readFileSync(file);
      return { ok: true, status: 200, json: async () => JSON.parse(buf), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    }
    throw new Error(`offline: ${url}`); // cutouts and external services are not needed here
  };
  for (const k of ["window", "document", "location", "history", "navigator", "HTMLElement", "Node", "ImageData", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", "localStorage", "sessionStorage", "matchMedia", "ResizeObserver", "CustomEvent", "Event", "KeyboardEvent", "MouseEvent", "DOMParser"]) {
    try { Object.defineProperty(globalThis, k, { value: w[k] ?? globalThis[k], configurable: true, writable: true }); } catch { /* read-only global */ }
  }
  globalThis.window = w;
  globalThis.ImageData = class { constructor(a, b) { this.width = a; this.height = b ?? a; this.data = new Uint8ClampedArray(this.width * this.height * 4); } };
  globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
  globalThis.fetch = fetchOverride ?? realFetch;
  console.warn = () => {}; // expected: image downloads are blocked offline
  await import(`file:///${path.join(ROOT, "js", "app.js").replace(/\\/g, "/")}?run=${Math.random()}`);
  return w;
}

function indexFetch(mutate, tile) {
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "index.json")));
  mutate?.(index);
  return async (url) => {
    if (url === "data/index.json") return { ok: true, json: async () => index };
    if (url.startsWith("data/tiles/")) return tile(url);
    throw new Error(`offline: ${url}`);
  };
}

async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error("timed out");
}


module.exports = { ROOT, loadSpaceLapse, indexFetch, until };
