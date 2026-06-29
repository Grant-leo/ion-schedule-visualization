import { createRenderer } from "./canvas_renderer.js?v=20260629-demo8";
import { renderDagSvg } from "./dag_renderer.js?v=20260629-demo8";
import { createReplay, validateTrace } from "./replay.js?v=20260629-demo8";
import {
  createMetricCards,
  createScenarioCopy,
  describeEvent,
  formatLocation,
  summarizeDag,
} from "./ui_model.js?v=20260629-demo8";

const elements = {
  traceSelect: document.getElementById("traceSelect"),
  scenarioTitle: document.getElementById("scenarioTitle"),
  scenarioDescription: document.getElementById("scenarioDescription"),
  programSelect: document.getElementById("programSelect"),
  architectureSelect: document.getElementById("architectureSelect"),
  capacitySelect: document.getElementById("capacitySelect"),
  mapperSelect: document.getElementById("mapperSelect"),
  orderingSelect: document.getElementById("orderingSelect"),
  schedulerSelect: document.getElementById("schedulerSelect"),
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
  dagSummaryPanel: document.getElementById("dagSummaryPanel"),
  eventPanel: document.getElementById("eventPanel"),
  validationPanel: document.getElementById("validationPanel"),
  performancePanel: document.getElementById("performancePanel"),
  benchmarkMetaPanel: document.getElementById("benchmarkMetaPanel"),
  runConfigPanel: document.getElementById("runConfigPanel"),
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
let programCatalog = new Map();

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
  programCatalog = new Map((options.programs || []).map((program) => [program.id, program]));
  fillSelect(
    elements.programSelect,
    options.programs.map((program) => ({ value: program.id, label: programOptionLabel(program) })),
  );
  fillSelect(elements.architectureSelect, options.machines);
  fillSelect(elements.capacitySelect, options.capacities.map(String));
  fillSelect(elements.mapperSelect, options.mappers);
  fillSelect(elements.orderingSelect, options.orderings || ["Naive", "Fidelity"]);
  fillSelect(elements.schedulerSelect, options.scheduler_options || options.schedulers || ["EJF"]);
  renderSelectedBenchmark();
}

function fillSelect(select, values) {
  select.replaceChildren();
  for (const value of values) {
    const option = document.createElement("option");
    option.value = typeof value === "object" ? value.value ?? value.id : value;
    option.textContent = typeof value === "object" ? value.label ?? value.id : value;
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
    orderings: ["Naive"],
    schedulers: ["EJF"],
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
  elements.programSelect.addEventListener("change", renderSelectedBenchmark);
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
  renderScenarioSummary(trace);
  renderRunConfig(trace);
  resetInspectorRenderCache();

  const valid = frontendValidation.valid && backendValidation.valid;
  setStatus(valid ? "Schedule verified" : "Trace invalid", valid ? "valid" : "invalid");
  draw();
}

async function loadSelectedConfig() {
  const program = elements.programSelect.value;
  const machine = elements.architectureSelect.value;
  const capacity = Number(elements.capacitySelect.value);
  const mapper = elements.mapperSelect.value;
  const ordering = elements.orderingSelect.value;
  const scheduler = elements.schedulerSelect.value;

  if (apiAvailable) {
    setStatus("Generating schedule", "loading");
    try {
      const params = new URLSearchParams({
        program,
        machine,
        capacity: String(capacity),
        mapper,
        ordering,
        scheduler,
      });
      const nextTrace = await fetchJson(`api/trace?${params.toString()}`);
      const key = `generated:${program}:${machine}:${capacity}:${mapper}:${ordering}:${scheduler}`;
      generatedTraces.set(key, nextTrace);
      upsertTraceOption(
        key,
        `${programLabelFromId(program)} | ${machine} | cap ${capacity} | ${mapper} | ${ordering} | ${scheduler}`,
      );
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
      (entry.reorder === undefined || entry.reorder === ordering) &&
      (entry.scheduler_policy === undefined || entry.scheduler_policy === scheduler) &&
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
  setSelectValue(elements.orderingSelect, run.reorder);
  setSelectValue(elements.schedulerSelect, run.scheduler_policy);
  renderSelectedBenchmark();
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
  setSelectValue(elements.orderingSelect, defaults.ordering);
  setSelectValue(elements.schedulerSelect, defaults.scheduler);
  renderSelectedBenchmark();
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

function programOptionLabel(program) {
  const label = program.label || program.id;
  if (!Number.isInteger(program.qubits)) return label;
  const category = program.category ? `${program.category}, ` : "";
  return `${label} (${category}${program.qubits}q, CX ${program.cx ?? 0})`;
}

function renderSelectedBenchmark() {
  const program = programCatalog.get(elements.programSelect.value);
  if (!program) {
    elements.benchmarkMetaPanel.textContent = "";
    return;
  }
  const meta = [
    program.source || "local",
    program.category,
    `${program.qubits ?? "?"} qubits`,
    `${program.cx ?? 0} CX`,
    `${program.total_ops ?? 0} ops`,
  ].filter(Boolean);
  elements.benchmarkMetaPanel.textContent = meta.join(" | ");
}

function renderRunConfig(nextTrace) {
  const run = nextTrace.run || {};
  const program = programCatalog.get(programIdFromPath(run.program));
  const items = [
    program?.label || programLabelFromId(programIdFromPath(run.program)),
    run.machine,
    `cap ${run.ions_per_region}`,
    run.mapper ? `mapper ${run.mapper}` : null,
    run.reorder ? `ordering ${run.reorder}` : null,
    run.scheduler_policy ? `scheduler ${run.scheduler_policy}` : null,
  ].filter(Boolean);
  elements.runConfigPanel.textContent = items.join(" | ");
}

function renderScenarioSummary(nextTrace) {
  const run = nextTrace.run || {};
  const program = programCatalog.get(programIdFromPath(run.program));
  const copy = createScenarioCopy({ run, program });
  elements.scenarioTitle.textContent = copy.title;
  elements.scenarioDescription.textContent = copy.description;
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
    renderDagSummary(state.dagState);
    renderDagSvg(elements.dagPanel, state.dagState, { direction: "vertical" });
    lastDagKey = dagKey;
  }

  const eventKey = activeEventKey(state.activeEvents);
  if (eventKey !== lastEventKey) {
    renderCurrentEvent(state);
    lastEventKey = eventKey;
  }
}

function renderMetrics(metrics, replayMetrics) {
  const cards = createMetricCards({
    ...(metrics || {}),
    shuttling_time: metrics?.shuttling_time ?? replayMetrics?.shuttlingTime,
  });
  const grid = document.createElement("div");
  grid.className = "metric-grid";
  for (const card of cards) {
    const item = document.createElement("article");
    item.className = "metric-card";
    const label = document.createElement("span");
    label.className = "metric-label";
    label.textContent = card.label;
    const value = document.createElement("strong");
    value.className = "metric-value";
    value.textContent = card.value;
    const detail = document.createElement("span");
    detail.className = "metric-detail";
    detail.textContent = card.detail;
    item.append(label, value, detail);
    grid.appendChild(item);
  }
  elements.metricsPanel.replaceChildren(grid);
}

function renderCurrentEvent(state) {
  const activeEvents = state.activeEvents || [];
  if (activeEvents.length === 0) {
    const empty = document.createElement("p");
    empty.className = "event-empty";
    empty.textContent = "No active hardware operation";
    elements.eventPanel.replaceChildren(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const event of activeEvents.slice(0, 3)) {
    const item = document.createElement("article");
    item.className = `event-item event-${event.type || "operation"}`;
    const type = document.createElement("span");
    type.className = "event-type";
    type.textContent = String(event.type || "operation").toUpperCase();
    const summary = document.createElement("strong");
    summary.className = "event-summary";
    summary.textContent = describeEvent(event);
    const meta = document.createElement("span");
    meta.className = "event-meta";
    meta.textContent = `t=${event.start}-${event.end} | ${formatLocation(event.source)} -> ${formatLocation(event.target)}`;
    item.append(type, summary, meta);
    fragment.appendChild(item);
  }
  if (activeEvents.length > 3) {
    const more = document.createElement("span");
    more.className = "event-more";
    more.textContent = `+${activeEvents.length - 3} concurrent operations`;
    fragment.appendChild(more);
  }
  elements.eventPanel.replaceChildren(fragment);
}

function renderDagSummary(dagState) {
  const summary = summarizeDag(dagState);
  const completedRatio = summary.total > 0 ? summary.completed / summary.total : 0;
  const wrapper = document.createElement("div");
  wrapper.className = "dag-summary-card";

  const topLine = document.createElement("div");
  topLine.className = "dag-summary-top";
  const progressText = document.createElement("strong");
  progressText.textContent = `${summary.completed}/${summary.total} completed`;
  const edgeText = document.createElement("span");
  edgeText.textContent = `${summary.edges} dependencies`;
  topLine.append(progressText, edgeText);

  const progress = document.createElement("div");
  progress.className = "dag-progress";
  const progressFill = document.createElement("span");
  progressFill.style.width = `${Math.round(completedRatio * 100)}%`;
  progress.appendChild(progressFill);

  const chips = document.createElement("div");
  chips.className = "dag-state-chips";
  for (const [label, value] of [
    ["Active", summary.active],
    ["Ready", summary.ready],
    ["Blocked", summary.blocked],
  ]) {
    const chip = document.createElement("span");
    chip.textContent = `${label} ${value}`;
    chips.appendChild(chip);
  }

  wrapper.append(topLine, progress, chips);
  elements.dagSummaryPanel.replaceChildren(wrapper);
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
