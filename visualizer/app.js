import { createRenderer } from "./canvas_renderer.js";
import { renderDagSvg } from "./dag_renderer.js";
import { createReplay, validateTrace } from "./replay.js";

const elements = {
  traceSelect: document.getElementById("traceSelect"),
  programSelect: document.getElementById("programSelect"),
  architectureSelect: document.getElementById("architectureSelect"),
  capacitySelect: document.getElementById("capacitySelect"),
  mapperSelect: document.getElementById("mapperSelect"),
  loadConfigButton: document.getElementById("loadConfigButton"),
  playPauseButton: document.getElementById("playPauseButton"),
  restartButton: document.getElementById("restartButton"),
  stepButton: document.getElementById("stepButton"),
  speedSelect: document.getElementById("speedSelect"),
  timeline: document.getElementById("timeline"),
  canvas: document.getElementById("vizCanvas"),
  metricsPanel: document.getElementById("metricsPanel"),
  initialLayoutPanel: document.getElementById("initialLayoutPanel"),
  dagPanel: document.getElementById("dagPanel"),
  eventPanel: document.getElementById("eventPanel"),
  validationPanel: document.getElementById("validationPanel"),
  performancePanel: document.getElementById("performancePanel"),
  timeReadout: document.getElementById("timeReadout"),
};

const renderer = createRenderer(elements.canvas);

let replay = null;
let trace = null;
let currentTime = 0;
let playing = false;
let lastFrame = performance.now();
let frameTimes = [];
let manifestEntries = [];
let generatedTraces = new Map();
let apiOptions = null;
let apiAvailable = false;
let renderedMetricsTrace = null;
let lastInitialLayoutKey = "";
let lastDagKey = "";
let lastEventKey = "";

init().catch((error) => {
  elements.validationPanel.textContent = "Load failed";
  elements.validationPanel.classList.add("is-invalid");
  elements.eventPanel.textContent = error.stack || String(error);
});

async function init() {
  manifestEntries = await fetchJson("traces/manifest.json");
  apiOptions = await fetchJson("api/options").catch(() => null);
  apiAvailable = Boolean(apiOptions);
  populateTraceSelector(manifestEntries);
  populateConfigControls(apiOptions || configOptionsFromManifest(manifestEntries));
  wireControls();

  if (apiAvailable) {
    applyDefaultConfig(apiOptions.defaults);
    await loadSelectedConfig();
  } else if (manifestEntries.length > 0) {
    await loadTrace(manifestEntries[0].path);
  } else {
    elements.validationPanel.textContent = "No traces";
  }

  requestAnimationFrame(loop);
}

function populateTraceSelector(manifest) {
  elements.traceSelect.replaceChildren();
  for (const item of manifest) {
    const option = document.createElement("option");
    option.value = item.path;
    option.textContent = item.label;
    elements.traceSelect.appendChild(option);
  }
}

function populateConfigControls(options) {
  fillSelect(
    elements.programSelect,
    options.programs.map((program) => ({ value: program.id, label: program.label || program.id })),
  );
  fillSelect(elements.architectureSelect, options.machines);
  fillSelect(elements.capacitySelect, options.capacities.map(String));
  fillSelect(elements.mapperSelect, options.mappers);
}

function fillSelect(select, values) {
  select.replaceChildren();
  for (const value of values) {
    const option = document.createElement("option");
    option.value = typeof value === "object" ? value.value : value;
    option.textContent = typeof value === "object" ? value.label : value;
    select.appendChild(option);
  }
}

function configOptionsFromManifest(manifest) {
  const programById = new Map();
  for (const item of manifest) {
    const id = programIdFromPath(item.program || item.path || item.id);
    programById.set(id, { id, label: item.program ? programLabelFromId(id) : item.label || id });
  }
  return {
    programs: [...programById.values()],
    machines: uniqueValues(manifest, "machine"),
    capacities: uniqueValues(manifest, "ions_per_region"),
    mappers: uniqueValues(manifest, "mapper"),
  };
}

function wireControls() {
  elements.traceSelect.addEventListener("change", () => {
    const value = elements.traceSelect.value;
    if (generatedTraces.has(value)) {
      loadTraceData(generatedTraces.get(value));
    } else {
      loadTrace(value);
    }
  });
  elements.loadConfigButton.addEventListener("click", loadSelectedConfig);
  elements.playPauseButton.addEventListener("click", togglePlayback);
  elements.restartButton.addEventListener("click", restart);
  elements.stepButton.addEventListener("click", stepToNextEvent);
  elements.timeline.addEventListener("input", () => {
    currentTime = Number(elements.timeline.value);
    draw();
  });
}

async function loadTrace(path) {
  const nextTrace = await fetchJson(path);
  loadTraceData(nextTrace);
}

function loadTraceData(nextTrace) {
  trace = nextTrace;
  const frontendValidation = validateTrace(trace);
  const backendValidation = trace.validation || { valid: true, errors: [] };
  replay = createReplay(trace);
  renderer.setTrace(trace);

  currentTime = 0;
  playing = false;
  elements.playPauseButton.textContent = "Play";
  elements.timeline.max = String(Math.max(1, replay.finishTime));
  elements.timeline.value = "0";
  syncConfigControls(trace);
  resetInspectorRenderCache();

  const valid = frontendValidation.valid && backendValidation.valid;
  setStatus(valid ? "Valid trace" : "Invalid trace", valid ? "valid" : "invalid");
  draw();
}

async function loadSelectedConfig() {
  const program = elements.programSelect.value;
  const machine = elements.architectureSelect.value;
  const capacity = Number(elements.capacitySelect.value);
  const mapper = elements.mapperSelect.value;

  if (apiAvailable) {
    setStatus("Generating schedule", "loading");
    try {
      const params = new URLSearchParams({ program, machine, capacity: String(capacity), mapper });
      const nextTrace = await fetchJson(`api/trace?${params.toString()}`);
      const key = `generated:${program}:${machine}:${capacity}:${mapper}`;
      generatedTraces.set(key, nextTrace);
      upsertTraceOption(key, `${programLabelFromId(program)} | ${machine} | cap ${capacity} | ${mapper}`);
      elements.traceSelect.value = key;
      loadTraceData(nextTrace);
    } catch (error) {
      setStatus("Generation failed", "invalid");
      elements.eventPanel.textContent = error.stack || String(error);
    }
    return;
  }

  const match = manifestEntries.find(
    (entry) =>
      entry.machine === machine &&
      entry.ions_per_region === capacity &&
      entry.mapper === mapper &&
      programIdFromPath(entry.program || entry.path || entry.id) === program,
  );
  if (!match) {
    setStatus("Config trace missing", "invalid");
    return;
  }
  elements.traceSelect.value = match.path;
  await loadTrace(match.path);
}

function syncConfigControls(nextTrace) {
  const run = nextTrace.run || {};
  setSelectValue(elements.programSelect, programIdFromPath(run.program));
  setSelectValue(elements.architectureSelect, run.machine);
  setSelectValue(elements.capacitySelect, String(run.ions_per_region));
  setSelectValue(elements.mapperSelect, run.mapper);
}

function setSelectValue(select, value) {
  if (value === undefined || value === null) return;
  const stringValue = String(value);
  if ([...select.options].some((option) => option.value === stringValue)) {
    select.value = stringValue;
  }
}

function applyDefaultConfig(defaults = {}) {
  setSelectValue(elements.programSelect, defaults.program);
  setSelectValue(elements.architectureSelect, defaults.machine);
  setSelectValue(elements.capacitySelect, String(defaults.capacity));
  setSelectValue(elements.mapperSelect, defaults.mapper);
}

function upsertTraceOption(value, label) {
  let option = [...elements.traceSelect.options].find((item) => item.value === value);
  if (!option) {
    option = document.createElement("option");
    option.value = value;
    elements.traceSelect.prepend(option);
  }
  option.textContent = label;
}

function uniqueValues(items, key) {
  return [...new Set(items.map((item) => item[key]).filter((value) => value !== undefined))].sort();
}

function programIdFromPath(path = "") {
  const normalized = String(path).replaceAll("\\", "/");
  const file = normalized.split("/").pop() || normalized;
  return file.replace(/\.[^.]+$/, "");
}

function programLabelFromId(id = "") {
  return id.replaceAll("_", " ");
}

function setStatus(message, state) {
  elements.validationPanel.textContent = message;
  elements.validationPanel.classList.toggle("is-valid", state === "valid");
  elements.validationPanel.classList.toggle("is-invalid", state === "invalid");
  elements.validationPanel.classList.toggle("is-loading", state === "loading");
}

function togglePlayback() {
  if (!replay) return;
  playing = !playing;
  elements.playPauseButton.textContent = playing ? "Pause" : "Play";
}

function restart() {
  currentTime = 0;
  playing = false;
  elements.playPauseButton.textContent = "Play";
  draw();
}

function stepToNextEvent() {
  if (!replay) return;
  currentTime = replay.nextEventTime(currentTime);
  draw();
}

function loop(now) {
  const delta = now - lastFrame;
  lastFrame = now;

  if (playing && replay) {
    currentTime = Math.min(replay.finishTime, currentTime + delta * Number(elements.speedSelect.value));
    if (currentTime >= replay.finishTime) {
      playing = false;
      elements.playPauseButton.textContent = "Play";
    }
    draw();
  }

  recordFrame(delta);
  requestAnimationFrame(loop);
}

function draw() {
  if (!replay || !trace) return;
  const state = replay.stateAt(currentTime);
  renderer.draw(state);
  elements.timeline.value = String(Math.floor(state.time));
  elements.timeReadout.textContent = `${Math.floor(state.time)} / ${replay.finishTime}`;
  if (renderedMetricsTrace !== trace) {
    renderMetrics(trace.metrics, state.metrics);
    renderedMetricsTrace = trace;
  }

  const initialLayoutKey = trapChainsKey(state.trapChains);
  if (initialLayoutKey !== lastInitialLayoutKey) {
    renderInitialLayout(state);
    lastInitialLayoutKey = initialLayoutKey;
  }

  const dagKey = dagStateKey(state.dagState);
  if (dagKey !== lastDagKey) {
    renderDagSvg(elements.dagPanel, state.dagState);
    lastDagKey = dagKey;
  }

  const eventKey = activeEventKey(state.activeEvents);
  if (eventKey !== lastEventKey) {
    renderCurrentEvent(state);
    lastEventKey = eventKey;
  }
}

function renderMetrics(metrics, replayMetrics) {
  const values = [
    ["Finish", metrics.finish_time],
    ["Events", metrics.event_count],
    ["1Q / 2Q Gates", `${metrics.one_qubit_gates} / ${metrics.two_qubit_gates}`],
    ["Gate Count", metrics.counts.gate],
    ["Split / Move / Merge", `${metrics.counts.split} / ${metrics.counts.move} / ${metrics.counts.merge}`],
    ["Gate Time", metrics.times.gate],
    ["Shuttling Time", metrics.shuttling_time ?? replayMetrics.shuttlingTime],
  ];

  const list = document.createElement("dl");
  for (const [label, value] of values) {
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    detail.textContent = String(value ?? 0);
    list.append(term, detail);
  }
  elements.metricsPanel.replaceChildren(list);
}

function renderCurrentEvent(state) {
  const event = state.activeEvents[0];
  elements.eventPanel.textContent = event ? JSON.stringify(event, null, 2) : "No active event";
}

function renderInitialLayout(state) {
  const container = document.createElement("div");
  container.className = "initial-layout";
  for (const trap of trace.topology.traps) {
    const row = document.createElement("div");
    row.className = "layout-row";
    const label = document.createElement("span");
    label.textContent = `T${trap.id}`;
    const chain = document.createElement("div");
    chain.className = "layout-chain";
    for (const ion of state.trapChains.get(`trap:${trap.id}`) || []) {
      const chip = document.createElement("span");
      chip.className = "layout-ion";
      chip.textContent = String(ion);
      chain.appendChild(chip);
    }
    row.append(label, chain);
    container.appendChild(row);
  }
  elements.initialLayoutPanel.replaceChildren(container);
}

function recordFrame(delta) {
  frameTimes.push(delta);
  if (frameTimes.length > 60) frameTimes.shift();
  const average = frameTimes.reduce((sum, item) => sum + item, 0) / Math.max(1, frameTimes.length);
  const fps = average > 0 ? 1000 / average : 0;
  elements.performancePanel.textContent = `FPS: ${fps.toFixed(1)} | events: ${trace?.events.length ?? 0}`;
}

function resetInspectorRenderCache() {
  renderedMetricsTrace = null;
  lastInitialLayoutKey = "";
  lastDagKey = "";
  lastEventKey = "";
}

function trapChainsKey(trapChains) {
  return [...trapChains.entries()].map(([location, ions]) => `${location}:${ions.join(",")}`).join("|");
}

function dagStateKey(dagState) {
  return `${sortedSetKey(dagState.completed)}|${sortedSetKey(dagState.active)}`;
}

function activeEventKey(activeEvents) {
  return activeEvents.map((event) => event.id).join(",");
}

function sortedSetKey(values) {
  return [...(values || [])].sort((left, right) => left - right).join(",");
}

async function fetchJson(path) {
  const response = await fetch(path);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(payload?.error || `Failed to load ${path}: ${response.status}`);
  }
  return payload;
}
