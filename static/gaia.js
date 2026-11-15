"use strict";

// Optional Gaia DR3 overlay: catalog positions from VizieR drawn over the 128x128 sky grid.
// Gaia path ported from js/context.js. Plain browser JS, no imports. The overlay never
// queries on its own: only turning the toggle on, Query Gaia, or Retry sends a request.
const GaiaOverlay = (() => {
  const VIZIER_ASU_URL = "https://vizier.cfa.harvard.edu/viz-bin/asu-tsv";
  const GAIA_CATALOG = "I/355/gaiadr3";
  const GAIA_TABLE = GAIA_CATALOG.replace(/\//g, "_"); // name used in VizieR "#Table" lines
  const GAIA_FIELDS = "Source,RA_ICRS,DE_ICRS,pmRA,pmDE";
  const GAIA_EPOCH = 2016.0; // DR3 reference epoch J2016.0
  const MAX_SOURCES = 50; // nearest sources kept; more reads as "capped"
  const QUERY_TIMEOUT_MS = 15000;
  const CACHE_SIZE = 8;
  const GRID = 128; // matches GRID_SIZE in app.py
  const MARKER_RADIUS = 0.85; // ring radius in grid units (~1.2 arcsec at 3 arcmin)
  const SVG = "http://www.w3.org/2000/svg";
  const DEG = Math.PI / 180;
  const MAS_PER_DEG = 3600000;
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  function numericCell(value) {
    const s = String(value ?? "").trim();
    if (!s || s === "?" || s === "--" || /^nan$/i.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  // Parse VizieR ASU TSV for the Gaia table. Anything that is not a recognisable Gaia
  // table throws, so a broken response can never read as "no sources".
  function parseVizierTSV(text) {
    if (typeof text !== "string" || !text.trim()) throw new Error("VizieR returned an empty response.");
    if (/<html[\s>]/i.test(text)) throw new Error("VizieR returned an HTML error page instead of catalog data.");
    const lines = text.replace(/^﻿/, "").split(/\r?\n/);
    const serviceError = lines.find((line) => /^#(?:ERROR|WARNING)\b/i.test(line.trim()));
    if (serviceError) throw new Error(serviceError.replace(/^#\s*/, "").trim());
    const hasTable = lines.some((line) => new RegExp(`^#Table\\s+${GAIA_TABLE}:`).test(line));
    let header = null;
    const sources = [];
    for (const line of lines) {
      if (!line || line.startsWith("#")) continue;
      const cells = line.split("\t");
      if (!header && cells.some((cell) => cell.trim() === "Source")) {
        header = cells.map((cell) => cell.trim());
        continue;
      }
      if (!header || /^[-\s]*$/.test(line)) continue;
      const row = Object.fromEntries(header.map((name, i) => [name, (cells[i] ?? "").trim()]));
      if (!row.Source) continue; // units line
      sources.push(sourceFromRow(row));
    }
    if (!header && hasTable) return { sources: [], truncated: false };
    if (!header) throw new Error("VizieR response did not contain a recognized Gaia DR3 table.");
    return { sources, truncated: sources.length > MAX_SOURCES };
  }

  function sourceFromRow(row) {
    const ra = numericCell(row.RA_ICRS), dec = numericCell(row.DE_ICRS);
    if (ra === null || dec === null || ra < 0 || ra >= 360 || dec < -90 || dec > 90) {
      throw new Error("VizieR returned a Gaia row with invalid coordinates.");
    }
    // pmra is Gaia's mu_alpha*cos(dec), in mas/yr.
    return { id: row.Source, ra, dec, epoch: GAIA_EPOCH, pmra: numericCell(row.pmRA), pmdec: numericCell(row.pmDE) };
  }

  function checkField(field) {
    const ra = Number(field?.ra), dec = Number(field?.dec), fovArcmin = Number(field?.fovArcmin);
    if (!Number.isFinite(ra) || ra < 0 || ra >= 360) throw new RangeError("ra must be in [0, 360).");
    if (!Number.isFinite(dec) || dec < -90 || dec > 90) throw new RangeError("dec must be in [-90, 90].");
    if (!Number.isFinite(fovArcmin) || fovArcmin <= 0 || fovArcmin > 60) throw new RangeError("fovArcmin must be in (0, 60].");
    return { ra, dec, fovArcmin };
  }

  // Circumscribed circle of the square field, as in app.py query_collection().
  function coneRadiusArcmin(fovArcmin) { return fovArcmin / Math.SQRT2; }

  function queryUrl(field) {
    const { ra, dec, fovArcmin } = checkField(field);
    const params = new URLSearchParams({
      "-source": GAIA_CATALOG,
      "-c": `${ra} ${dec}`,
      "-c.rm": String(coneRadiusArcmin(fovArcmin)), // VizieR's -c.rm unit is arcminutes
      "-out": GAIA_FIELDS,
      "-out.add": "_r",
      "-sort": "_r",
      "-out.max": String(MAX_SOURCES + 1), // one extra row reveals the cap
    });
    return `${VIZIER_ASU_URL}?${params}`;
  }

  const abortError = () => new DOMException("Gaia query cancelled.", "AbortError");

  // One cone query. Resolves {sources (<= MAX_SOURCES, nearest first), capped, queriedAt, field};
  // rejects with "Query failed, Gaia not checked (...)" or an AbortError if cancelled.
  async function fetchGaia(field, { signal, fetch: fetchImpl = globalThis.fetch, timeoutMs = QUERY_TIMEOUT_MS, now = () => new Date() } = {}) {
    const checked = checkField(field);
    const url = queryUrl(checked);
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (signal?.aborted) throw abortError();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const parsed = parseVizierTSV(await response.text());
      if (signal?.aborted) throw abortError();
      return { sources: parsed.sources.slice(0, MAX_SOURCES), capped: parsed.truncated, queriedAt: now().toISOString(), field: checked };
    } catch (error) {
      if (signal?.aborted) throw abortError();
      const cause = timedOut ? `timed out after ${timeoutMs / 1000} s` :
        error instanceof TypeError ? "network or browser CORS failure" : error.message;
      throw new Error(`Query failed, Gaia not checked (${cause}).`, { cause: error });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  function decimalYear(date) {
    if (typeof date === "number" && Number.isFinite(date)) return date;
    const value = date instanceof Date ? date : new Date(date);
    if (!Number.isFinite(value.getTime())) throw new TypeError("date must be a decimal year, Date, or valid date string.");
    const year = value.getUTCFullYear();
    const start = Date.UTC(year, 0, 1), end = Date.UTC(year + 1, 0, 1);
    return year + (value.getTime() - start) / (end - start);
  }

  // Linear proper motion along a great circle; no parallax or radial-velocity terms.
  function propagate(raDeg, decDeg, pmra, pmdec, years) {
    const ra = raDeg * DEG, dec = decDeg * DEG;
    const r = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
    // pmra is mu_alpha*cos(dec); the east/north tangent basis avoids dividing by cos(dec).
    const east = [-Math.sin(ra), Math.cos(ra), 0];
    const north = [-Math.sin(dec) * Math.cos(ra), -Math.sin(dec) * Math.sin(ra), Math.cos(dec)];
    const eastMotion = pmra * years, northMotion = pmdec * years;
    const motion = Math.hypot(eastMotion, northMotion);
    if (!motion) return { ra: ((raDeg % 360) + 360) % 360, dec: decDeg };
    const theta = motion / MAS_PER_DEG * DEG;
    const direction = east.map((v, i) => (v * eastMotion + north[i] * northMotion) / motion);
    const moved = r.map((v, i) => v * Math.cos(theta) + direction[i] * Math.sin(theta));
    const nextRa = Math.atan2(moved[1], moved[0]) / DEG;
    const nextDec = Math.asin(Math.max(-1, Math.min(1, moved[2]))) / DEG;
    return { ra: (nextRa + 360) % 360, dec: nextDec };
  }

  // Positions at `date`. Sources without complete proper motion keep their J2016.0 position.
  function propagateSources(sources, date) {
    const target = decimalYear(date);
    return sources.map((source) => {
      const hasMotion = Number.isFinite(source.pmra) && Number.isFinite(source.pmdec);
      if (!hasMotion) return { source, ra: source.ra, dec: source.dec, projected: false };
      return { source, ...propagate(source.ra, source.dec, source.pmra, source.pmdec, target - source.epoch), projected: true };
    });
  }

  // The grid of app.py render_cutout(): RA---TAN/DEC--TAN at the field center, north up,
  // east left, fov/size per pixel, row 0 at the north edge. Returns SVG user units where
  // pixel i spans [i, i+1), so the field center is (size/2, size/2). Null if behind the plane.
  function projectToGrid(ra, dec, field, size = GRID) {
    const a = ra * DEG, d = dec * DEG, a0 = field.ra * DEG, d0 = field.dec * DEG;
    const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
    if (!(cosc > 0)) return null;
    const xi = Math.cos(d) * Math.sin(a - a0) / cosc / DEG; // degrees, east positive
    const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / cosc / DEG;
    const perDegree = size / (field.fovArcmin / 60);
    return { x: size / 2 - xi * perDegree, y: size / 2 - eta * perDegree };
  }

  function cacheKey(field) {
    return `${field.ra.toFixed(7)}|${field.dec.toFixed(7)}|${coneRadiusArcmin(field.fovArcmin).toFixed(6)}`;
  }

  // UI controller. els: { toggle, panel, status, action, provenance, svg }.
  // The viewer calls setField() on search start (null) and success, setFrameDate() on draw,
  // and restore() for a shared link. phase: off | pending | loading | failed | ready.
  function createOverlay(els, { fetch: fetchImpl } = {}) {
    const cache = new Map();
    const s = { enabled: false, phase: "off", field: null, result: null, error: null, frameDate: null, controller: null, generation: 0 };

    function cancel() {
      s.generation++;
      s.controller?.abort();
      s.controller = null;
    }

    function fromCache(field) {
      const key = cacheKey(field);
      const hit = cache.get(key);
      if (hit) { cache.delete(key); cache.set(key, hit); }
      return hit;
    }

    async function query() {
      if (!s.enabled || !s.field) return;
      cancel();
      const cached = fromCache(s.field);
      if (cached) { Object.assign(s, { phase: "ready", result: cached, error: null }); render(); return; }
      const generation = s.generation;
      const controller = new AbortController();
      Object.assign(s, { controller, phase: "loading", result: null, error: null });
      render();
      try {
        const result = await fetchGaia(s.field, { signal: controller.signal, fetch: fetchImpl });
        if (generation !== s.generation) return;
        cache.set(cacheKey(result.field), result);
        while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
        Object.assign(s, { phase: "ready", result });
      } catch (error) {
        if (generation !== s.generation || error.name === "AbortError") return;
        Object.assign(s, { phase: "failed", error: error.message });
      } finally {
        if (generation === s.generation) s.controller = null;
      }
      render();
    }

    function setEnabled(enabled, { fromUser = true } = {}) {
      cancel();
      s.enabled = enabled;
      els.toggle.checked = enabled;
      Object.assign(s, { phase: enabled ? "pending" : "off", result: null, error: null });
      render();
      if (enabled && fromUser) query();
    }

    // A shared link restores the toggle only; it never sends a request.
    function restore(enabled) { setEnabled(Boolean(enabled), { fromUser: false }); }

    // New field (or null while a search runs): abort any query and drop the old result.
    // A cached result for the same field is reused, which sends nothing.
    function setField(field) {
      cancel();
      s.field = field ? checkField(field) : null;
      const cached = s.enabled && s.field ? fromCache(s.field) : null;
      Object.assign(s, { phase: !s.enabled ? "off" : cached ? "ready" : "pending", result: cached || null, error: null });
      render();
    }

    function setFrameDate(date) {
      s.frameDate = date || null;
      render();
    }

    function epochText() {
      if (!s.frameDate) return "the displayed frame's date (no frame displayed)";
      return `${s.frameDate.slice(0, 10)} (${decimalYear(s.frameDate).toFixed(3)})`;
    }

    function statusText(inside) {
      if (s.phase === "pending") return `Gaia not queried yet.${s.field ? "" : " Search a field first."}`;
      if (s.phase === "loading") return "Querying Gaia DR3 via VizieR...";
      if (s.phase === "failed") return `${s.error} No markers are shown.`;
      if (s.phase !== "ready") return "";
      const { sources, capped } = s.result;
      if (!sources.length) return "0 Gaia DR3 sources in this field.";
      const noMotion = sources.filter((src) => !(Number.isFinite(src.pmra) && Number.isFinite(src.pmdec))).length;
      const head = capped ?
        `Capped at ${MAX_SOURCES}: showing the ${MAX_SOURCES} Gaia DR3 sources nearest the center; more exist in this field.` :
        `${plural(sources.length, "Gaia DR3 source")} in the query cone.`;
      const where = inside === null ? "" : ` ${inside} inside the image.`;
      return `${head}${where}${noMotion ? ` ${noMotion} without proper motion (dashed, J2016.0 position).` : ""}`;
    }

    function drawMarkers() {
      const svg = els.svg;
      svg.replaceChildren();
      const show = s.enabled && s.phase === "ready" && s.frameDate && s.field;
      svg.style.display = show ? "" : "none"; // SVG elements do not honour .hidden everywhere
      if (!show) return null;
      const doc = svg.ownerDocument;
      let inside = 0;
      for (const p of propagateSources(s.result.sources, s.frameDate)) {
        const xy = projectToGrid(p.ra, p.dec, s.field);
        if (!xy || xy.x < 0 || xy.x > GRID || xy.y < 0 || xy.y > GRID) continue;
        inside++;
        const circle = doc.createElementNS(SVG, "circle");
        circle.setAttribute("cx", xy.x.toFixed(3));
        circle.setAttribute("cy", xy.y.toFixed(3));
        circle.setAttribute("r", String(MARKER_RADIUS));
        circle.setAttribute("class", p.projected ? "gaia-marker" : "gaia-marker no-pm");
        const title = doc.createElementNS(SVG, "title");
        title.textContent = `Gaia DR3 ${p.source.id}${p.projected ? "" : " (no proper motion; J2016.0 position)"}`;
        circle.append(title);
        svg.append(circle);
      }
      return inside;
    }

    function render() {
      els.panel.hidden = !s.enabled;
      const inside = drawMarkers();
      els.status.textContent = statusText(inside);
      els.status.classList.toggle("error", s.phase === "failed");
      els.action.hidden = s.phase !== "pending" && s.phase !== "failed";
      els.action.textContent = s.phase === "failed" ? "Retry" : "Query Gaia";
      els.action.disabled = !s.field;
      els.provenance.textContent = s.phase === "ready" ?
        `Gaia DR3 (${GAIA_CATALOG}), queried via VizieR ASU on ${s.result.queriedAt.slice(0, 10)} UTC, linear proper-motion propagation to ${epochText()}.` : "";
    }

    els.toggle.addEventListener("change", () => setEnabled(els.toggle.checked));
    els.action.addEventListener("click", query);
    render();
    return { restore, setEnabled, setField, setFrameDate, query, isEnabled: () => s.enabled, snapshot: () => ({ ...s }) };
  }

  return {
    VIZIER_ASU_URL, GAIA_CATALOG, MAX_SOURCES, QUERY_TIMEOUT_MS, GRID, MARKER_RADIUS,
    parseVizierTSV, queryUrl, coneRadiusArcmin, fetchGaia, decimalYear, propagate, propagateSources, projectToGrid, createOverlay,
  };
})();

// For Node tests; no-op in the browser.
if (typeof module === "object" && module.exports) module.exports = GaiaOverlay;
