"use strict";

const $ = (id) => document.getElementById(id);
const MAX_SELECTED = 32;    // frames are ~90 KB each once aligned
const LOAD_CONCURRENCY = 4; // cutouts fetched in parallel
// WISE 0855 moves ~8 arcsec/yr west; by 2025-26 it is ~2 arcmin from the
// challenge's reference position (see docs/VERIFICATION.md), so the default
// sample uses a CatWISE2020-propagated 2026.0 position.
const samples = { barnard: [269.446268, 4.768204], wise: [133.75947, -7.242557], wiseref: [133.7951292, -7.2451472] };
const state = { search: null, selected: new Set(), frames: [], current: 0, a: 0, b: 1, timer: null, busy: false, generation: 0 };
const bandLabels = { "SPHEREx-D1": "D1 / 0.75-1.09 um", "SPHEREx-D2": "D2 / 1.10-1.62 um", "SPHEREx-D3": "D3 / 1.63-2.41 um", "SPHEREx-D4": "D4 / 2.42-3.82 um", "SPHEREx-D5": "D5 / 3.83-4.41 um", "SPHEREx-D6": "D6 / 4.42-5.00 um" };

function status(message, error = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
}

async function api(url) {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}

function stop() {
  clearInterval(state.timer);
  state.timer = null;
  $("play").textContent = "Play";
}

function setBusy(busy) {
  state.busy = busy;
  $("search-button").disabled = busy;
  $("band").disabled = busy || !state.search?.records.length;
  $("suggest").disabled = busy || !state.search?.records.length;
  $("load").disabled = busy || !state.selected.size;
  $("records").querySelectorAll("input, button").forEach((el) => { el.disabled = busy; });
  drawTimeline();
}

function drawTimeline() {
  ObservationTimeline.render($("coverage"), {
    search: state.search,
    band: state.search?.records.length ? $("band").value : null,
    selected: state.selected,
    loaded: new Set(state.frames.map((f) => f.record.id)),
    busy: state.busy,
    onPick: pickFromTimeline,
  });
}

function pickFromTimeline(group) {
  if (state.busy) return;
  const ids = group.records.map((r) => r.id);
  if (group.band !== $("band").value) {
    // Comparisons stay within one detector, so switching rows switches band.
    $("band").value = group.band;
    clearFrames();
    state.selected.clear();
  }
  const already = ids.filter((id) => state.selected.has(id));
  if (already.length) {
    already.forEach((id) => state.selected.delete(id));
    status(`Deselected ${group.day} ${group.band.replace("SPHEREx-", "")}.`);
  } else if (state.selected.size >= MAX_SELECTED) {
    status(`Choose at most ${MAX_SELECTED} cutouts. Deselect an exposure first.`, true);
  } else {
    state.selected.add(ids[0]);
    status(`Selected the first of ${ids.length} ${group.band.replace("SPHEREx-", "")} exposure${ids.length > 1 ? "s" : ""} on ${group.day}. Click Load selected to fetch it.`);
  }
  renderTable();
}

function filtered() {
  return state.search?.records.filter((r) => r.band === $("band").value) || [];
}

function clearFrames() {
  stop();
  state.frames = [];
  state.current = 0;
  $("sky").style.display = "none";
  document.querySelector(".crosshair").style.display = "none";
  $("empty-state").hidden = false;
  $("image-badge").hidden = true;
  $("scale").hidden = true;
  for (const id of ["prev", "play", "next", "timeline", "low", "high", "reset-stretch"]) $(id).disabled = true;
  $("timeline").max = "0";
  $("timeline").value = "0";
  $("low").value = "";
  $("high").value = "";
  $("frame-details").textContent = "No frames loaded for this selection.";
  $("timeline-labels").firstElementChild.textContent = "No frames loaded";
  $("timeline-labels").lastElementChild.textContent = "";
}

function pickEndpoints() {
  const rows = filtered();
  state.selected.clear();
  if (rows.length) {
    state.selected.add(rows[0].id);
    // Pick a different calendar date, rather than a second exposure from the same day.
    const last = [...rows].reverse().find((r) => r.date.slice(0, 10) !== rows[0].date.slice(0, 10));
    if (last) state.selected.add(last.id);
  }
  renderTable();
}

function updateSelection() {
  $("load").textContent = `Load selected (${state.selected.size})`;
  $("load").disabled = state.busy || !state.selected.size;
  const rows = filtered();
  const dates = new Set(rows.map((r) => r.date.slice(0, 10)));
  $("selection-summary").textContent = `${rows.length} exposures / ${dates.size} calendar dates / ${state.selected.size} selected`;
  drawTimeline();
}

function cell(row, value) {
  const td = document.createElement("td");
  td.textContent = value;
  row.append(td);
  return td;
}

function renderTable() {
  const tbody = $("records");
  tbody.replaceChildren();
  const rows = filtered();
  $("record-count").textContent = `${state.search?.records.length || 0} TOTAL RECORDS`;
  if (!rows.length) {
    const row = document.createElement("tr");
    const td = cell(row, state.search ? "No exposures in this band / searched collections." : "Search a field to see its observation history.");
    td.colSpan = 6;
    td.className = "table-empty";
    tbody.append(row);
  }
  for (const record of rows) {
    const row = document.createElement("tr");
    const td = cell(row, "");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = state.selected.has(record.id);
    check.disabled = state.busy;
    check.setAttribute("aria-label", `Select ${record.date} ${record.release} ${record.observation}`);
    check.addEventListener("change", () => {
      if (check.checked && state.selected.size >= MAX_SELECTED) {
        check.checked = false;
        status(`Choose at most ${MAX_SELECTED} cutouts. Deselect an exposure first.`, true);
        return;
      }
      if (check.checked) state.selected.add(record.id);
      else state.selected.delete(record.id);
      updateSelection();
    });
    td.append(check);
    cell(row, record.date.replace("T", " "));
    cell(row, `${record.release}${record.collection.endsWith("_deep") ? " / deep" : ""}`);
    cell(row, `${record.range_um.map((v) => v.toFixed(3)).join("-")} um`);
    cell(row, record.observation);
    const action = cell(row, "");
    const frameIndex = state.frames.findIndex((f) => f.record.id === record.id);
    if (frameIndex >= 0) {
      for (const pin of ["a", "b"]) {
        const button = document.createElement("button");
        button.textContent = pin.toUpperCase();
        button.type = "button";
        button.classList.toggle("active-pin", state[pin] === frameIndex);
        button.setAttribute("aria-label", `Pin ${record.date} as ${pin.toUpperCase()}`);
        button.addEventListener("click", () => {
          stop();
          state[pin] = frameIndex;
          state.current = frameIndex;
          draw();
          renderTable();
        });
        action.append(button);
      }
    }
    const link = document.createElement("a");
    link.href = record.cutout_url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "FITS ↗";
    action.append(link);
    tbody.append(row);
  }
  updateSelection();
}

function decodePixels(base64) {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const pixels = new Float32Array(bytes.length / 4);
  for (let i = 0; i < pixels.length; i++) pixels[i] = view.getFloat32(i * 4, true);
  return pixels;
}

function autoStretch() {
  const values = [];
  for (const frame of state.frames) for (const value of frame.values) if (Number.isFinite(value)) values.push(value);
  values.sort((a, b) => a - b);
  const low = values[Math.floor((values.length - 1) * 0.01)];
  const high = values[Math.floor((values.length - 1) * 0.995)];
  $("low").value = low.toPrecision(6);
  $("high").value = (high > low ? high : low + 1).toPrecision(6);
}

function draw() {
  const frame = state.frames[state.current];
  if (!frame) return;
  const low = Number($("low").value), high = Number($("high").value);
  if (!$("low").value || !$("high").value || !Number.isFinite(low) || !Number.isFinite(high) || high <= low) {
    stop();
    status("Stretch high must be greater than low, and both must be finite.", true);
    return;
  }
  const canvas = $("sky");
  canvas.width = frame.size;
  canvas.height = frame.size;
  const ctx = canvas.getContext("2d");
  const pixels = ctx.createImageData(frame.size, frame.size);
  for (let i = 0; i < frame.values.length; i++) {
    const value = frame.values[i];
    const level = Number.isFinite(value) ? Math.round(255 * Math.asinh(10 * Math.max(0, Math.min(1, (value - low) / (high - low)))) / Math.asinh(10)) : 0;
    const offset = i * 4;
    pixels.data[offset] = Number.isFinite(value) ? level : 12;
    pixels.data[offset + 1] = Number.isFinite(value) ? level : 23;
    pixels.data[offset + 2] = Number.isFinite(value) ? level : 40;
    pixels.data[offset + 3] = 255;
  }
  ctx.putImageData(pixels, 0, 0);
  canvas.style.display = "block";
  document.querySelector(".crosshair").style.display = "block";
  $("empty-state").hidden = true;
  $("image-badge").hidden = false;
  const r = frame.record;
  $("image-badge").textContent = `${r.date.replace("T", " ")} | ${r.release} | ${r.band.replace("SPHEREx-", "")}`;
  $("scale").hidden = false;
  $("scale").textContent = `${state.search.fov_arcmin} arcmin full width`;
  $("timeline").value = String(state.current);
  const wave = frame.wavelength_um === null ? "unavailable (target outside finite footprint or WCS)" : `${frame.wavelength_um.toFixed(4)} um / width ${frame.bandwidth_um.toFixed(4)} um`;
  $("frame-details").textContent = `Frame ${state.current + 1}/${state.frames.length} | ${r.observation} | ${r.collection} | Target wavelength: ${wave} | Finite display coverage: ${frame.coverage}% | Target in footprint: ${frame.center_covered ? "yes" : "no"} | Any FLAGS bits in cutout: ${frame.flagged_percent}% (includes source flags; not a bad-pixel fraction) | FINAST code: ${frame.astrometry_code ?? "not supplied"} | Pixels from: ${frame.source === "s3" ? "AWS S3 (partial read)" : "IRSA cutout service"} | ${frame.unit}. Same display scale for all frames.`;
  $("timeline-labels").firstElementChild.textContent = state.frames[0].record.date.slice(0, 10);
  $("timeline-labels").lastElementChild.textContent = state.frames.at(-1).record.date.slice(0, 10);
}

function step(delta) {
  if (!state.frames.length) return;
  if ($("mode").value === "blink") {
    state.current = state.current === state.a ? state.b : state.a;
  } else {
    state.current = (state.current + delta + state.frames.length) % state.frames.length;
  }
  draw();
}

async function loadFrames() {
  stop();
  const generation = state.generation;
  const rows = filtered().filter((r) => state.selected.has(r.id));
  if (!rows.length || state.busy) return;
  clearFrames();
  setBusy(true);
  const failures = [];
  const results = new Array(rows.length);
  const started = performance.now();
  let next = 0, done = 0;
  // A small worker pool keeps LOAD_CONCURRENCY requests in flight; results keep log order.
  const worker = async () => {
    while (next < rows.length) {
      const i = next++;
      try {
        const frame = await api(`/api/frame/${state.search.search_id}/${rows[i].id}`);
        results[i] = { ...frame, record: rows[i], values: decodePixels(frame.pixels) };
      } catch (error) {
        failures.push(`${rows[i].date}: ${error.message}`);
      }
      done++;
      if (generation === state.generation) status(`Fetched ${done}/${rows.length} cutouts (${LOAD_CONCURRENCY} at a time)...`);
    }
  };
  status(`Fetching ${rows.length} cutouts...`);
  await Promise.all(Array.from({ length: Math.min(LOAD_CONCURRENCY, rows.length) }, worker));
  if (generation !== state.generation) return;
  state.frames = results.filter(Boolean);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  setBusy(false);
  if (state.frames.length) {
    state.a = 0;
    state.b = state.frames.length - 1;
    state.current = 0;
    autoStretch();
    for (const id of ["timeline", "low", "high", "reset-stretch"]) $(id).disabled = false;
    for (const id of ["prev", "play", "next"]) $(id).disabled = state.frames.length < 2;
    $("timeline").max = String(state.frames.length - 1);
    draw();
  }
  renderTable();
  status(failures.length ? `${state.frames.length}/${rows.length} frames loaded in ${seconds} s. ${failures.join(" ")}` : `${state.frames.length} aligned frames ready in ${seconds} s. Pin A/B or play a time sequence.`, failures.length > 0);
}

async function searchField(event) {
  event?.preventDefault();
  if (state.busy || !$("search-form").reportValidity()) return;
  state.generation++;
  clearFrames();
  state.search = null;
  state.selected.clear();
  renderTable();
  $("warnings").hidden = true;
  setBusy(true);
  status("Querying IRSA observation metadata. This can take up to 90 seconds per collection...");
  const params = new URLSearchParams(new FormData($("search-form")));
  params.set("deep", $("deep").checked ? "1" : "0");
  try {
    state.search = await api(`/api/search?${params}`);
    $("warnings").textContent = state.search.warnings.join("\n");
    $("warnings").hidden = !state.search.warnings.length;
    const bands = [...new Set(state.search.records.map((r) => r.band))].sort();
    $("band").replaceChildren(...bands.map((band) => new Option(bandLabels[band], band)));
    $("field-label").textContent = `${state.search.ra.toFixed(4)}, ${state.search.dec.toFixed(4)} / ICRS`;
    setBusy(false);
    pickEndpoints();
    const share = new URL(window.location.href);
    share.search = params.toString();
    history.replaceState(null, "", share);
    const incomplete = (state.search.collection_status || []).filter((s) => s.status !== "ok" && s.status !== "empty").map((s) => s.collection);
    status(state.search.records.length ? `Found ${state.search.records.length} overlapping exposures.${incomplete.length ? ` Results are incomplete for ${incomplete.join(", ")}; see warnings.` : ""} Load the selected first/last dates to compare.` : state.search.warnings.length ? "No records returned from available collections. Coverage is unknown for failed collections; see warnings." : "No coverage in the searched collections for this field. Try another target or release.");
  } catch (error) {
    setBusy(false);
    status(error.message, true);
  }
}

$("sample").addEventListener("change", () => {
  const target = samples[$("sample").value];
  if (target) { $("ra").value = target[0]; $("dec").value = target[1]; }
});
for (const id of ["ra", "dec"]) $(id).addEventListener("input", () => { $("sample").value = "custom"; });
$("search-form").addEventListener("submit", searchField);
$("band").addEventListener("change", () => { clearFrames(); pickEndpoints(); status("Band changed. Load the selected exposures for this band."); });
$("suggest").addEventListener("click", pickEndpoints);
$("load").addEventListener("click", loadFrames);
$("prev").addEventListener("click", () => { stop(); step(-1); });
$("next").addEventListener("click", () => { stop(); step(1); });
$("play").addEventListener("click", () => {
  if (state.timer) { stop(); return; }
  if ($("mode").value === "blink" && state.a === state.b) { status("Pin different loaded frames as A and B to blink.", true); return; }
  $("play").textContent = "Pause";
  state.timer = setInterval(() => step(1), Number($("speed").value));
});
for (const id of ["mode", "speed"]) $(id).addEventListener("change", stop);
$("timeline").addEventListener("input", () => { stop(); state.current = Number($("timeline").value); draw(); });
for (const id of ["low", "high"]) $(id).addEventListener("change", draw);
$("reset-stretch").addEventListener("click", () => { autoStretch(); draw(); status("Shared stretch reset from all loaded frames."); });

const initial = new URLSearchParams(window.location.search);
for (const id of ["ra", "dec", "fov", "release"]) if (initial.has(id)) $(id).value = initial.get(id);
$("deep").checked = initial.get("deep") === "1";
if (initial.has("ra") || initial.has("dec")) $("sample").value = "custom";
