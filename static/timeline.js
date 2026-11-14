"use strict";

// Observation timeline: which UTC dates and detectors have data in each
// searched collection, and whether a collection's coverage is actually known.
// Kept separate from viewer.js; viewer.js calls ObservationTimeline.render().
const ObservationTimeline = (() => {
  const SVG = "http://www.w3.org/2000/svg";
  const BANDS = ["SPHEREx-D1", "SPHEREx-D2", "SPHEREx-D3", "SPHEREx-D4", "SPHEREx-D5", "SPHEREx-D6"];
  const RANGES = ["0.75-1.09", "1.10-1.62", "1.63-2.41", "2.42-3.82", "3.83-4.41", "4.42-5.00"];
  const WINDOW_GAP_DAYS = 30;
  const W = 960, LEFT = 104, RIGHT = 16, TOP = 34, ROW = 30, BOTTOM = 8;
  const STATUS_TEXT = {
    ok: (s) => `${s.count} exposures`,
    empty: () => "searched: no exposures here",
    partial: (s) => `${s.count} exposures, ${s.skipped} unreadable rows skipped`,
    truncated: (s) => `${s.count} exposures shown; list capped, later dates may be missing`,
    failed: () => "query failed: coverage unknown",
  };

  function el(name, attrs = {}, text) {
    const node = document.createElementNS(SVG, name);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function releaseClass(collection) {
    return `${collection.includes("qr3") ? "qr3" : "dr1"}${collection.endsWith("_deep") ? " deep" : ""}`;
  }

  function label(collection) {
    const [, release, deep] = collection.split("_");
    return `${release.toUpperCase()}${deep ? " deep" : ""}`;
  }

  // One mark per (detector, UTC day, collection).
  function groupRecords(records) {
    const groups = new Map();
    for (const record of records) {
      const day = record.date.slice(0, 10);
      const key = `${record.band}|${day}|${record.collection}`;
      if (!groups.has(key)) groups.set(key, { key, band: record.band, day, collection: record.collection, mjd: record.mjd, records: [] });
      groups.get(key).records.push(record);
    }
    for (const group of groups.values()) group.records.sort((a, b) => a.mjd - b.mjd);
    return [...groups.values()].sort((a, b) => a.mjd - b.mjd);
  }

  function surveyWindows(records) {
    const mjds = records.map((r) => r.mjd).sort((a, b) => a - b);
    const windows = [];
    for (const mjd of mjds) {
      const last = windows.at(-1);
      if (last && mjd - last.end <= WINDOW_GAP_DAYS) { last.end = mjd; last.count++; } else windows.push({ start: mjd, end: mjd, count: 1 });
    }
    return windows;
  }

  function mjdToDate(mjd) { return new Date((mjd - 40587) * 86400000); }
  function dateToMjd(date) { return date.getTime() / 86400000 + 40587; }

  function renderStatus(list, search) {
    list.replaceChildren();
    for (const s of search?.collection_status || []) {
      const li = document.createElement("li");
      li.className = `status-${s.status}`;
      const swatch = document.createElement("span");
      swatch.className = `swatch ${releaseClass(s.collection)}`;
      const name = document.createElement("b");
      name.textContent = label(s.collection);
      li.append(swatch, name, ` ${STATUS_TEXT[s.status]?.(s) ?? s.status}`);
      li.title = s.message;
      list.append(li);
    }
  }

  function render(root, { search, band, selected, loaded, busy, onPick }) {
    const chart = root.querySelector(".obs-chart");
    renderStatus(root.querySelector(".collection-status"), search);
    const summary = root.querySelector(".obs-summary");
    const records = search?.records || [];
    chart.replaceChildren();
    if (!records.length) {
      const failed = (search?.collection_status || []).some((s) => s.status === "failed");
      const p = document.createElement("p");
      p.className = "table-empty";
      p.textContent = !search ? "Search a field to see which dates and detectors have data."
        : failed ? "No exposures returned. At least one collection failed, so coverage is unknown, not empty."
          : "The searched collections have no exposures of this field.";
      chart.append(p);
      summary.textContent = "";
      return;
    }

    const groups = groupRecords(records);
    const windows = surveyWindows(records);
    let min = records[0].mjd, max = records[0].mjd;
    for (const r of records) { min = Math.min(min, r.mjd); max = Math.max(max, r.mjd); }
    const pad = Math.max(2, (max - min) * 0.03);
    min -= pad; max += pad;
    const plotW = W - LEFT - RIGHT, H = TOP + ROW * BANDS.length + BOTTOM;
    const x = (mjd) => LEFT + ((mjd - min) / (max - min)) * plotW;

    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "group", "aria-label": "Observation timeline by detector" });

    // Survey windows: a shaded band per cluster of dates, labelled with its span.
    for (const w of windows) {
      const x0 = x(w.start) - 4, x1 = x(w.end) + 4;
      svg.append(el("rect", { x: x0, y: TOP - 4, width: x1 - x0, height: ROW * BANDS.length + 4, class: "obs-window" }));
      const days = Math.round(w.end - w.start) + 1;
      if (x1 - x0 > 70) svg.append(el("text", { x: (x0 + x1) / 2, y: TOP - 8, class: "obs-window-label", "text-anchor": "middle" }, `${days} d / ${w.count} exp`));
    }

    // Month ticks, thinned so labels never collide.
    const months = [];
    const cursor = mjdToDate(min);
    cursor.setUTCDate(1); cursor.setUTCHours(0, 0, 0, 0);
    while (dateToMjd(cursor) <= max) {
      if (dateToMjd(cursor) >= min) months.push(new Date(cursor));
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    const every = Math.max(1, Math.ceil(months.length / Math.floor(plotW / 64)));
    months.forEach((month, i) => {
      const mx = x(dateToMjd(month));
      svg.append(el("line", { x1: mx, x2: mx, y1: TOP, y2: H - BOTTOM, class: "obs-grid" }));
      if (i % every === 0) svg.append(el("text", { x: mx + 3, y: 12, class: "obs-axis" }, month.toISOString().slice(0, 7)));
    });

    BANDS.forEach((b, i) => {
      const y = TOP + i * ROW;
      const active = b === band;
      svg.append(el("rect", { x: 0, y, width: W, height: ROW, class: `obs-row${i % 2 ? " alt" : ""}${active ? " active" : ""}` }));
      const text = el("text", { x: 8, y: y + 19, class: `obs-band${active ? " active" : ""}` }, `D${i + 1}`);
      text.append(el("tspan", { class: "obs-band-range", dx: 6 }, `${RANGES[i]} um`));
      svg.append(text);
    });

    for (const group of groups) {
      const row = BANDS.indexOf(group.band);
      if (row < 0) continue;
      const cx = x(group.mjd), y = TOP + row * ROW;
      const ids = group.records.map((r) => r.id);
      const isSelected = ids.some((id) => selected.has(id));
      const isLoaded = ids.some((id) => loaded.has(id));
      const g = el("g", { class: `obs-mark ${releaseClass(group.collection)}${isSelected ? " selected" : ""}${busy ? " busy" : ""}`, tabindex: busy ? -1 : 0, role: "button" });
      const lo = Math.min(...group.records.map((r) => r.range_um[0])), hi = Math.max(...group.records.map((r) => r.range_um[1]));
      const description = `${group.day}, ${group.band.replace("SPHEREx-", "")}, ${label(group.collection)}: ${ids.length} exposure${ids.length > 1 ? "s" : ""}, ${lo.toFixed(2)}-${hi.toFixed(2)} um${isSelected ? ", selected" : ""}${isLoaded ? ", loaded" : ""}`;
      g.setAttribute("aria-label", `${description}. Activate to ${isSelected ? "deselect" : "select"}.`);
      g.setAttribute("aria-pressed", String(isSelected));
      g.append(el("title", {}, description));
      g.append(el("rect", { x: cx - 6, y, width: 12, height: ROW, class: "obs-hit" }));
      g.append(el("rect", { x: cx - 2, y: y + 6, width: 4, height: ROW - 12, rx: 1, class: "obs-tick" }));
      if (isLoaded) g.append(el("circle", { cx, cy: y + ROW - 3, r: 2, class: "obs-loaded" }));
      const pick = (event) => { event.preventDefault(); if (!busy) onPick(group); };
      g.addEventListener("click", pick);
      g.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") pick(event); });
      svg.append(g);
    }
    chart.append(svg);

    const dates = new Set(records.map((r) => r.date.slice(0, 10)));
    const bandDates = new Set(records.filter((r) => r.band === band).map((r) => r.date.slice(0, 10)));
    summary.textContent = `${records.length} exposures on ${dates.size} UTC dates in ${windows.length} survey window${windows.length > 1 ? "s" : ""}, ${records[0].date.slice(0, 10)} to ${records.at(-1).date.slice(0, 10)}. ${band ? `${band.replace("SPHEREx-", "")} has ${bandDates.size} dates.` : ""} Click a mark to select that date's first exposure; click again to deselect.`;
  }

  return { render, groupRecords, surveyWindows };
})();
