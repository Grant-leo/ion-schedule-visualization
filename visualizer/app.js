import { createRenderer } from "./canvas_renderer.js";
import { createReplay, validateTrace } from "./replay.js";

const elements = {
  traceSelect: document.getElementById("traceSelect"),
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

init().catch((error) => {
  elements.validationPanel.textContent = "Load failed";
  elements.validationPanel.classList.add("is-invalid");
  elements.eventPanel.textContent = error.stack || String(error);
});

async function init() {
  manifestEntries = await fetchJson("traces/manifest.json");
  populateTraceSelector(manifestEntries);
  populateConfigControls(manifestEntries);
  wireControls();

  if (manifestEntries.length > 0) {
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

function populateConfigControls(manifest) {
  fillSelect(elements.architectureSelect, uniqueValues(manifest, "machine"));
  fillSelect(elements.capacitySelect, uniqueValues(manifest, "ions_per_region").map(String));
  fillSelect(elements.mapperSelect, uniqueValues(manifest, "mapper"));
}

function fillSelect(select, values) {
  select.replaceChildren();
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  }
}

function uniqueValues(items, key) {
  return [...new Set(items.map((item) => item[key]).filter((value) => value !== undefined))].sort();
}

function wireControls() {
  elements.traceSelect.addEventListener("change", () => loadTrace(elements.traceSelect.value));
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
  trace = await fetchJson(path);
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

  const valid = frontendValidation.valid && backendValidation.valid;
  elements.validationPanel.textContent = valid ? "Valid trace" : "Invalid trace";
  elements.validationPanel.classList.toggle("is-valid", valid);
  elements.validationPanel.classList.toggle("is-invalid", !valid);
  draw();
}

async function loadSelectedConfig() {
  const machine = elements.architectureSelect.value;
  const capacity = Number(elements.capacitySelect.value);
  const mapper = elements.mapperSelect.value;
  const match = manifestEntries.find(
    (entry) => entry.machine === machine && entry.ions_per_region === capacity && entry.mapper === mapper,
  );
  if (!match) {
    elements.validationPanel.textContent = "Config trace missing";
    elements.validationPanel.classList.add("is-invalid");
    return;
  }
  elements.traceSelect.value = match.path;
  await loadTrace(match.path);
}

function syncConfigControls(nextTrace) {
  const run = nextTrace.run || {};
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
  renderMetrics(trace.metrics, state.metrics);
  renderInitialLayout(state);
  renderDag(state.dagState);
  renderCurrentEvent(state);
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

function renderDag(dagState) {
  const graph = document.createElement("div");
  graph.className = "dag-graph";
  const levels = dagLevels(dagState);
  for (const level of levels) {
    const layer = document.createElement("div");
    layer.className = "dag-layer";
    for (const node of level) {
      const item = document.createElement("div");
      item.className = `dag-node ${node.state}`;
      item.title = `gate ${node.id} | q${node.qubits.join(", q")}`;
      item.textContent = `${node.id}:${node.gate_name}`;
      layer.appendChild(item);
    }
    graph.appendChild(layer);
  }
  elements.dagPanel.replaceChildren(graph);
}

function dagLevels(dagState) {
  const incoming = new Map([...dagState.nodes.keys()].map((id) => [id, []]));
  for (const edge of dagState.edges || []) {
    if (!incoming.has(edge.target)) incoming.set(edge.target, []);
    incoming.get(edge.target).push(edge.source);
  }
  const cache = new Map();
  const levelOf = (id) => {
    if (cache.has(id)) return cache.get(id);
    const level = Math.max(-1, ...(incoming.get(id) || []).map(levelOf)) + 1;
    cache.set(id, level);
    return level;
  };
  const layers = [];
  for (const [id, node] of dagState.nodes) {
    const level = levelOf(id);
    if (!layers[level]) layers[level] = [];
    layers[level].push(node);
  }
  return layers.filter(Boolean);
}

function recordFrame(delta) {
  frameTimes.push(delta);
  if (frameTimes.length > 60) frameTimes.shift();
  const average = frameTimes.reduce((sum, item) => sum + item, 0) / Math.max(1, frameTimes.length);
  const fps = average > 0 ? 1000 / average : 0;
  elements.performancePanel.textContent = `FPS: ${fps.toFixed(1)} | events: ${trace?.events.length ?? 0}`;
}

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Failed to load ${path}: ${response.status}`);
  }
  return response.json();
}
