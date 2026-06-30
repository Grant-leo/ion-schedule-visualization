import { createRenderer } from "./canvas_renderer.js?v=20260630-uniform-motion1";
import { renderCircuitSvg } from "./circuit_renderer.js?v=20260630-circuit-parallel2";
import { renderDagSvg } from "./dag_renderer.js?v=20260630-swap-circuit1";
import { createReplay, validateTrace } from "./replay.js?v=20260630-swap-circuit1";
import {
  createHeadlineMetricCards,
  createMetricCards,
  createScenarioCopy,
  createValidationSummary,
  describeEvent,
  eventDurationMicroseconds,
  formatLocation,
  playbackDeltaCycles,
  playbackScaleSummary,
  summarizeDag,
} from "./ui_model.js?v=20260630-motion-continuous1";

const LIVE_PANEL_INTERVAL_MS = 160;
const PERFORMANCE_PANEL_INTERVAL_MS = 250;

const elements = {
  controlPanel: document.getElementById("controlPanel"),
  controlScrollRegion: document.getElementById("controlScrollRegion"),
  traceSelect: document.getElementById("traceSelect"),
  sourceModeButtons: [...document.querySelectorAll("[data-source-mode]")],
  scenarioTitle: document.getElementById("scenarioTitle"),
  scenarioDescription: document.getElementById("scenarioDescription"),
  programSelect: document.getElementById("programSelect"),
  architectureSelect: document.getElementById("architectureSelect"),
  capacitySelect: document.getElementById("capacitySelect"),
  mapperSelect: document.getElementById("mapperSelect"),
  orderingSelect: document.getElementById("orderingSelect"),
  schedulerSelect: document.getElementById("schedulerSelect"),
  schedulerModeButtons: [...document.querySelectorAll("[data-scheduler-mode]")],
  loadConfigButton: document.getElementById("loadConfigButton"),
  configErrorPanel: document.getElementById("configErrorPanel"),
  playPauseButton: document.getElementById("playPauseButton"),
  restartButton: document.getElementById("restartButton"),
  stepButton: document.getElementById("stepButton"),
  speedSelect: document.getElementById("speedSelect"),
  timeline: document.getElementById("timeline"),
  canvas: document.getElementById("vizCanvas"),
  circuitPanel: document.getElementById("circuitPanel"),
  circuitExpandButton: document.getElementById("circuitExpandButton"),
  circuitDialog: document.getElementById("circuitDialog"),
  circuitDialogPanel: document.getElementById("circuitDialogPanel"),
  circuitCloseButton: document.getElementById("circuitCloseButton"),
  headlineMetricsPanel: document.getElementById("headlineMetricsPanel"),
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

const GENERATION_LOCKED_ELEMENTS = [
  elements.traceSelect,
  elements.programSelect,
  elements.architectureSelect,
  elements.capacitySelect,
  elements.mapperSelect,
  elements.orderingSelect,
  elements.schedulerSelect,
  elements.playPauseButton,
  elements.restartButton,
  elements.stepButton,
  elements.speedSelect,
  elements.timeline,
];

const EXPERIMENT_CONFIG_ELEMENTS = [
  elements.programSelect,
  elements.architectureSelect,
  elements.capacitySelect,
  elements.mapperSelect,
  elements.orderingSelect,
  elements.schedulerSelect,
  elements.loadConfigButton,
];

const PLAYBACK_ELEMENTS = [elements.playPauseButton, elements.restartButton, elements.stepButton, elements.timeline];

const renderer = createRenderer(elements.canvas);

let replay = null;
let trace = null;
let currentTime = 0;
let playing = false;
let lastFrame = performance.now();
let frameTimes = [];
let manifestEntries = [];
let apiOptions = null;
let apiAvailable = false;
let previousTraceMetrics = null;
let renderedMetricsTrace = null;
let lastMetricsDagKey = "";
let lastHeadlineKey = "";
let lastInitialLayoutKey = "";
let lastDagKey = "";
let lastEventKey = "";
let programCatalog = new Map();
let machineTrapCounts = new Map();
let loadRequestId = 0;
let activeLoadController = null;
let generationLoading = false;
let traceBlocked = true;
let sourceMode = "experiment";
let lastLivePanelRender = 0;
let lastPerformancePanelRender = 0;
let lastCircuitKey = "";
let lastExpandedCircuitKey = "";
let latestTimeDelta = null;

init().catch((error) => {
  const message = formatErrorMessage(error);
  setStatus("Load failed", "invalid", message);
  setReplayBlocked(true);
  elements.eventPanel.textContent = message;
  showConfigError(message);
});

async function init() {
  manifestEntries = await fetchJson("traces/manifest.json");
  apiOptions = await fetchJson("api/options").catch(() => null);
  apiAvailable = Boolean(apiOptions);
  populateTraceSelector(manifestEntries);
  populateConfigControls(apiOptions || configOptionsFromManifest(manifestEntries));
  wireControls();
  setSourceMode(apiAvailable ? "experiment" : "trace");

  if (apiAvailable) {
    applyDefaultConfig(apiOptions.defaults);
    await loadSelectedConfig({ preserveControlScroll: false });
  } else if (manifestEntries.length > 0) {
    await loadTrace(manifestEntries[0].path);
  } else {
    setStatus("Schedule blocked", "invalid", "No traces are available.");
    setReplayBlocked(true);
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
  machineTrapCounts = new Map(
    Object.entries(options.machine_trap_counts || {}).map(([machine, count]) => [machine, Number(count)]),
  );
  fillSelect(
    elements.programSelect,
    options.programs.map((program) => ({ value: program.id, label: programOptionLabel(program) })),
  );
  fillSelect(elements.architectureSelect, options.machines);
  fillSelect(elements.capacitySelect, options.capacities.map(String));
  fillSelect(elements.mapperSelect, options.mappers);
  fillSelect(elements.orderingSelect, options.orderings || ["Naive", "Fidelity"]);
  fillSelect(elements.schedulerSelect, options.scheduler_options || options.schedulers || ["EJF"]);
  updateSchedulerModeButtons();
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
    setSourceMode("trace");
    loadTrace(elements.traceSelect.value);
  });
  elements.loadConfigButton.addEventListener("click", () => loadSelectedConfig());
  for (const button of elements.sourceModeButtons) {
    button.addEventListener("click", async () => {
      const mode = button.dataset.sourceMode;
      if (!mode || button.disabled || mode === sourceMode) return;
      setSourceMode(mode);
      if (mode === "trace" && elements.traceSelect.value) {
        await loadTrace(elements.traceSelect.value);
      }
    });
  }
  elements.programSelect.addEventListener("change", () => {
    setSourceMode("experiment");
    renderSelectedBenchmark();
  });
  elements.architectureSelect.addEventListener("change", () => {
    setSourceMode("experiment");
    renderSelectedBenchmark();
  });
  elements.capacitySelect.addEventListener("change", () => {
    setSourceMode("experiment");
    renderSelectedBenchmark();
  });
  elements.mapperSelect.addEventListener("change", () => setSourceMode("experiment"));
  elements.orderingSelect.addEventListener("change", () => setSourceMode("experiment"));
  elements.schedulerSelect.addEventListener("change", () => {
    setSourceMode("experiment");
    updateSchedulerModeButtons();
  });
  for (const button of elements.schedulerModeButtons) {
    button.addEventListener("click", async () => {
      const scheduler = button.dataset.schedulerMode;
      if (!scheduler || button.disabled) return;
      setSourceMode("experiment");
      setSelectValue(elements.schedulerSelect, scheduler);
      updateSchedulerModeButtons();
      await loadSelectedConfig();
    });
  }
  elements.circuitExpandButton.addEventListener("click", openCircuitDialog);
  elements.circuitCloseButton.addEventListener("click", closeCircuitDialog);
  elements.circuitDialog.addEventListener("click", (event) => {
    if (event.target === elements.circuitDialog) closeCircuitDialog();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.circuitDialog.hidden) closeCircuitDialog();
  });
  elements.playPauseButton.addEventListener("click", togglePlayback);
  elements.restartButton.addEventListener("click", restart);
  elements.stepButton.addEventListener("click", stepToNextEvent);
  elements.speedSelect.addEventListener("change", () => {
    lastHeadlineKey = "";
    draw({ forcePanels: true });
  });
  elements.timeline.addEventListener("input", () => {
    if (generationLoading || traceBlocked) return;
    currentTime = Number(elements.timeline.value);
    draw({ forcePanels: true });
  });
  window.addEventListener("resize", () => {
    lastDagKey = "";
    lastCircuitKey = "";
    lastExpandedCircuitKey = "";
    draw({ forcePanels: true });
  });
}

async function loadTrace(path) {
  const { requestId, signal } = beginLoadRequest();
  try {
    const nextTrace = await fetchJson(path, { signal });
    if (requestId !== loadRequestId) return;
    loadTraceData(nextTrace);
  } catch (error) {
    if (isAbortError(error) || requestId !== loadRequestId) return;
    const message = formatErrorMessage(error);
    setStatus("Load failed", "invalid", message);
    setReplayBlocked(true);
    elements.eventPanel.textContent = message;
    showConfigError(message);
  }
}

function beginLoadRequest() {
  loadRequestId += 1;
  if (activeLoadController) activeLoadController.abort();
  activeLoadController = new AbortController();
  return { requestId: loadRequestId, signal: activeLoadController.signal };
}

function getControlScrollTop() {
  const scroller = elements.controlScrollRegion || elements.controlPanel;
  return scroller ? scroller.scrollTop : 0;
}

function restoreControlScrollTop(scrollTop) {
  if (scrollTop === null || scrollTop === undefined) return;
  const scroller = elements.controlScrollRegion || elements.controlPanel;
  if (scroller) scroller.scrollTop = scrollTop;
}

function loadTraceData(nextTrace, { resetControlPanelScroll = true } = {}) {
  const frontendValidation = validateTrace(nextTrace);
  const backendValidation = nextTrace.validation || { valid: true, errors: [] };
  const validationErrors = [...(frontendValidation.errors || []), ...(backendValidation.errors || [])];
  const valid = frontendValidation.valid && backendValidation.valid;
  renderValidationPanel({ valid, errors: validationErrors });
  if (!valid) {
    playing = false;
    elements.playPauseButton.textContent = "Play";
    const message = validationErrors.join("; ") || "Trace validation failed.";
    elements.eventPanel.textContent = formatErrorMessage(message);
    setReplayBlocked(true);
    showConfigError(message);
    return false;
  }

  const nextReplay = createReplay(nextTrace);
  previousTraceMetrics = trace?.metrics || null;
  trace = nextTrace;
  replay = nextReplay;
  setReplayBlocked(false);
  renderer.setTrace(nextTrace);
  clearConfigError();

  currentTime = 0;
  playing = false;
  elements.playPauseButton.textContent = "Play";
  elements.timeline.max = String(Math.max(1, replay.finishTime));
  elements.timeline.value = "0";
  latestTimeDelta = null;
  syncConfigControls(trace);
  applySourceModeAvailability();
  renderScenarioSummary(trace);
  renderRunConfig(trace);
  resetInspectorRenderCache();

  setStatus("Schedule verified", "valid");
  draw({ forcePanels: true });
  if (resetControlPanelScroll) {
    restoreControlScrollTop(0);
  }
  return true;
}

async function loadSelectedConfig({ preserveControlScroll = true } = {}) {
  setSourceMode("experiment");
  const controlScrollTop = preserveControlScroll ? getControlScrollTop() : null;
  const { requestId, signal } = beginLoadRequest();
  const program = elements.programSelect.value;
  const machine = elements.architectureSelect.value;
  const capacity = Number(elements.capacitySelect.value);
  const mapper = elements.mapperSelect.value;
  const ordering = elements.orderingSelect.value;
  const scheduler = elements.schedulerSelect.value;
  const feasibility = selectedCapacityFeasibility({ program, machine, capacity });
  clearConfigError();
  if (!feasibility.valid) {
    setStatus("Capacity too small", "invalid", feasibility.message);
    setReplayBlocked(true);
    elements.eventPanel.textContent = feasibility.message;
    showConfigError(feasibility.message);
    renderSelectedBenchmark();
    return;
  }
  setGenerationLoading(true);

  try {
    if (apiAvailable) {
      setStatus("Generating schedule", "loading");
      const params = new URLSearchParams({
        program,
        machine,
        capacity: String(capacity),
        mapper,
        ordering,
        scheduler,
      });
      const nextTrace = await fetchJson(`api/trace?${params.toString()}`, { signal });
      if (requestId !== loadRequestId) return;
      if (!loadTraceData(nextTrace, { resetControlPanelScroll: !preserveControlScroll })) return;
      restoreControlScrollTop(controlScrollTop);
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
      const message = "No pre-generated trace matches the selected circuit, architecture, mapper, and scheduler.";
      setStatus("Config trace missing", "invalid", message);
      setReplayBlocked(true);
      showConfigError(message);
      return;
    }
    elements.traceSelect.value = match.path;
    const nextTrace = await fetchJson(match.path, { signal });
    if (requestId !== loadRequestId) return;
    loadTraceData(nextTrace, { resetControlPanelScroll: !preserveControlScroll });
    restoreControlScrollTop(controlScrollTop);
  } catch (error) {
    if (isAbortError(error) || requestId !== loadRequestId) return;
    const message = formatErrorMessage(error);
    setStatus("Generation failed", "invalid", message);
    setReplayBlocked(true);
    elements.eventPanel.textContent = message;
    showConfigError(message);
  } finally {
    if (requestId === loadRequestId) {
      setGenerationLoading(false);
    }
  }
}

function syncConfigControls(nextTrace) {
  const run = nextTrace.run || {};
  setSelectValue(elements.programSelect, programIdFromPath(run.program));
  setSelectValue(elements.architectureSelect, run.machine);
  setSelectValue(elements.capacitySelect, String(run.ions_per_region));
  setSelectValue(elements.mapperSelect, run.mapper);
  setSelectValue(elements.orderingSelect, run.reorder);
  setSelectValue(elements.schedulerSelect, run.scheduler_policy);
  updateSchedulerModeButtons();
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
  updateSchedulerModeButtons();
  renderSelectedBenchmark();
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
    elements.benchmarkMetaPanel.classList.remove("is-warning");
    return;
  }
  const feasibility = selectedCapacityFeasibility();
  const meta = [
    program.source || "local",
    program.category,
    `${program.qubits ?? "?"} qubits`,
    `${program.cx ?? 0} CX`,
    `${program.total_ops ?? 0} ops`,
    feasibility.valid ? null : feasibility.shortMessage,
  ].filter(Boolean);
  elements.benchmarkMetaPanel.textContent = meta.join(" | ");
  elements.benchmarkMetaPanel.classList.toggle("is-warning", !feasibility.valid);
}

function selectedCapacityFeasibility(selection = {}) {
  const programId = selection.program || elements.programSelect.value;
  const machine = selection.machine || elements.architectureSelect.value;
  const capacity = Number(selection.capacity ?? elements.capacitySelect.value);
  const program = programCatalog.get(programId);
  const qubits = Number(program?.qubits || 0);
  const recommendedCapacity = machine === "L6" ? Number(program?.recommended_l6_min_capacity || 1) : 1;
  const trapCount = Number(machineTrapCounts.get(machine) || 0);
  if (!qubits || !trapCount || !capacity) return { valid: true };
  const slotCapacity = Math.ceil(qubits / trapCount);
  const requiredCapacity = Math.max(slotCapacity, recommendedCapacity);
  if (capacity >= requiredCapacity) return { valid: true, requiredCapacity };
  const shortMessage = `needs cap ${requiredCapacity}+ on ${machine}`;
  if (capacity >= slotCapacity && capacity < recommendedCapacity) {
    return {
      valid: false,
      requiredCapacity,
      shortMessage,
      message: `${programLabelFromId(programId)} fits total ion slots on ${machine}, but this benchmark needs demo-safe trap capacity ${requiredCapacity} or larger to avoid invalid intermediate trap occupancy.`,
    };
  }
  return {
    valid: false,
    requiredCapacity,
    shortMessage,
    message: `${programLabelFromId(programId)} requires ${qubits} logical qubits; ${machine} with capacity ${capacity} provides ${
      trapCount * capacity
    } ion slots. Choose capacity ${requiredCapacity} or larger.`,
  };
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

function renderValidationPanel({ valid, errors = [] }) {
  const validationErrors = errors;
  const summary = createValidationSummary({ valid, errors: validationErrors });
  renderStatusPanel(summary);
}

function setStatus(message, state, detail = "") {
  renderStatusPanel({
    state: state === "invalid" ? "blocked" : state,
    title: message,
    detail,
  });
}

function renderStatusPanel(summary) {
  elements.validationPanel.replaceChildren();
  const title = document.createElement("strong");
  title.textContent = summary.title;
  elements.validationPanel.appendChild(title);
  if (summary.detail) {
    const detail = document.createElement("span");
    detail.textContent = summary.detail;
    elements.validationPanel.appendChild(detail);
  }
  elements.validationPanel.setAttribute(
    "aria-label",
    summary.detail ? `${summary.title}: ${summary.detail}` : summary.title,
  );
  elements.validationPanel.hidden = summary.state !== "blocked";
  elements.validationPanel.classList.toggle("is-valid", summary.state === "valid");
  elements.validationPanel.classList.toggle("is-invalid", summary.state === "blocked");
  elements.validationPanel.classList.toggle("is-loading", summary.state === "loading");
}

function setReplayBlocked(isBlocked) {
  traceBlocked = isBlocked;
  updatePlaybackAvailability();
}

function updatePlaybackAvailability() {
  const disabled = generationLoading || traceBlocked || !replay;
  for (const element of PLAYBACK_ELEMENTS) {
    element.disabled = disabled;
  }
}

function setGenerationLoading(isLoading) {
  generationLoading = isLoading;
  if (isLoading) {
    playing = false;
    elements.playPauseButton.textContent = "Play";
  }
  elements.loadConfigButton.textContent = isLoading ? "Generating..." : "Generate Schedule";
  for (const element of GENERATION_LOCKED_ELEMENTS) {
    element.disabled = isLoading;
  }
  updatePlaybackAvailability();
  applySourceModeAvailability();
  updateSchedulerModeButtons();
}

function setSourceMode(mode) {
  sourceMode = mode === "trace" ? "trace" : "experiment";
  for (const button of elements.sourceModeButtons) {
    const active = button.dataset.sourceMode === sourceMode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
    button.disabled = generationLoading;
  }
  applySourceModeAvailability();
  updateSchedulerModeButtons();
}

function applySourceModeAvailability() {
  for (const button of elements.sourceModeButtons) {
    button.disabled = generationLoading;
  }
  elements.traceSelect.disabled = generationLoading || sourceMode !== "trace";
  const experimentDisabled = generationLoading || sourceMode !== "experiment";
  elements.loadConfigButton.disabled = generationLoading || sourceMode !== "experiment";
  for (const element of EXPERIMENT_CONFIG_ELEMENTS) {
    element.disabled = experimentDisabled;
  }
}

function showConfigError(message) {
  elements.configErrorPanel.textContent = message;
  elements.configErrorPanel.classList.add("is-visible");
}

function clearConfigError() {
  elements.configErrorPanel.textContent = "";
  elements.configErrorPanel.classList.remove("is-visible");
}

function togglePlayback() {
  if (!replay || generationLoading || traceBlocked) return;
  playing = !playing;
  elements.playPauseButton.textContent = playing ? "Pause" : "Play";
}

function restart() {
  if (generationLoading || traceBlocked) return;
  currentTime = 0;
  playing = false;
  elements.playPauseButton.textContent = "Play";
  draw({ forcePanels: true });
}

function stepToNextEvent() {
  if (!replay || generationLoading || traceBlocked) return;
  currentTime = replay.nextEventTime(currentTime);
  draw({ forcePanels: true });
}

function loop(now) {
  const delta = now - lastFrame;
  lastFrame = now;

  if (playing && replay) {
    const previousTime = currentTime;
    currentTime = Math.min(
      replay.finishTime,
      currentTime + playbackDeltaCycles(delta, Number(elements.speedSelect.value), trace),
    );
    emitCompletedTimeDelta(previousTime, currentTime);
    if (currentTime >= replay.finishTime) {
      playing = false;
      elements.playPauseButton.textContent = "Play";
    }
    draw();
  }

  recordFrame(delta, now);
  requestAnimationFrame(loop);
}

function draw(options = {}) {
  if (!replay || !trace) return;
  const forcePanels = Boolean(options.forcePanels);
  const state = replay.stateAt(currentTime);
  renderer.draw(state);
  elements.timeline.value = String(Math.floor(state.time));
  const dagProgress = summarizeDag(state.dagState);
  elements.timeReadout.textContent = `${dagProgress.completed} / ${dagProgress.total} gates`;

  const metricInput = buildMetricInput(trace.metrics, state.metrics, state.dagState);
  const now = performance.now();
  if (forcePanels || now - lastLivePanelRender >= LIVE_PANEL_INTERVAL_MS || !lastHeadlineKey) {
    renderHeadlineMetrics(metricInput, state.progressMetrics);
    lastLivePanelRender = now;
  }

  const dagKey = dagStateKey(state.dagState);
  if (renderedMetricsTrace !== trace || dagKey !== lastMetricsDagKey) {
    renderMetrics(metricInput);
    renderedMetricsTrace = trace;
    lastMetricsDagKey = dagKey;
  }

  const initialLayoutKey = trapChainsKey(state.trapChains);
  if (initialLayoutKey !== lastInitialLayoutKey) {
    renderInitialLayout(state);
    lastInitialLayoutKey = initialLayoutKey;
  }

  if (dagKey !== lastDagKey) {
    renderDagSummary(state.dagState);
    renderDagSvg(elements.dagPanel, state.dagState, { direction: "vertical" });
    focusDagViewport(elements.dagPanel);
    lastDagKey = dagKey;
  }

  const circuitSizeKey = `${elements.circuitPanel.clientWidth}x${elements.circuitPanel.clientHeight}`;
  const circuitKey = `${dagKey}|${trace?.particles?.length ?? 0}|${circuitSizeKey}`;
  if (circuitKey !== lastCircuitKey) {
    renderCircuitSvg(elements.circuitPanel, state.dagState, { qubitCount: trace.particles.length });
    lastCircuitKey = circuitKey;
  }
  if (!elements.circuitDialog.hidden) {
    renderExpandedCircuit(state, dagKey);
  }

  const eventKey = activeEventKey(state.activeEvents);
  if (eventKey !== lastEventKey) {
    renderCurrentEvent(state);
    lastEventKey = eventKey;
  }
}

function openCircuitDialog() {
  if (!replay || !trace) return;
  elements.circuitDialog.hidden = false;
  lastExpandedCircuitKey = "";
  draw({ forcePanels: true });
  elements.circuitCloseButton.focus();
}

function closeCircuitDialog() {
  elements.circuitDialog.hidden = true;
  lastExpandedCircuitKey = "";
  elements.circuitExpandButton.focus();
}

function renderExpandedCircuit(state, dagKey) {
  const expandedSizeKey = `${elements.circuitDialogPanel.clientWidth}x${elements.circuitDialogPanel.clientHeight}`;
  const expandedKey = `${dagKey}|${trace?.particles?.length ?? 0}|${expandedSizeKey}`;
  if (expandedKey === lastExpandedCircuitKey) return;
  renderCircuitSvg(elements.circuitDialogPanel, state.dagState, {
    qubitCount: trace.particles.length,
    maxWidth: Math.max(1280, elements.circuitDialogPanel.clientWidth || 0),
  });
  lastExpandedCircuitKey = expandedKey;
}

function buildMetricInput(metrics, replayMetrics, dagState) {
  const dagSummary = summarizeDag(dagState);
  const scaleSummary = playbackScaleSummary(elements.speedSelect.value, trace);
  return {
    timing: trace?.timing,
    cycle_time_us: trace?.timing?.cycle_time_us,
    playback_speed: Number(elements.speedSelect.value),
    playback_scale_label: scaleSummary.label,
    playback_scale_detail: scaleSummary.detail,
    latest_time_delta: latestTimeDelta?.text,
    latest_time_delta_key: latestTimeDelta?.key,
    event_count: metrics?.event_count ?? replayMetrics?.eventCount,
    finish_time: metrics?.finish_time ?? replayMetrics?.finishTime,
    counts: metrics?.counts ?? replayMetrics?.counts,
    times: metrics?.times ?? replayMetrics?.times,
    one_qubit_gates: metrics?.one_qubit_gates ?? replayMetrics?.oneQubitGates,
    two_qubit_gates: metrics?.two_qubit_gates ?? replayMetrics?.twoQubitGates,
    shuttling_time: metrics?.shuttling_time ?? replayMetrics?.shuttlingTime,
    swap_count: metrics?.swap_count ?? replayMetrics?.swapCount,
    swap_hops: metrics?.swap_hops ?? replayMetrics?.swapHops,
    ion_hops: metrics?.ion_hops ?? replayMetrics?.ionHops,
    max_parallel_gates: metrics?.max_parallel_gates ?? replayMetrics?.maxParallelGates,
    cross_trap_parallel_gates: metrics?.cross_trap_parallel_gates ?? replayMetrics?.crossTrapParallelGates,
    same_trap_gate_overlaps: metrics?.same_trap_gate_overlaps ?? replayMetrics?.sameTrapGateOverlaps,
    blocked_ops: dagSummary.blocked,
    ready_ops: dagSummary.ready,
  };
}

function renderMetrics(metricInput) {
  const cards = createMetricCards(metricInput);
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

function renderHeadlineMetrics(metricInput, progressMetrics = null) {
  const cards = createHeadlineMetricCards(metricInput, progressMetrics || previousTraceMetrics);
  const headlineKey = cards
    .map(
      (card) =>
        `${card.label}:${card.value}:${card.detail}:${card.subdetail || ""}:${card.progress ?? ""}:${card.badge || ""}:${
          card.deltaPulse?.key || ""
        }`,
    )
    .join("|");
  if (headlineKey === lastHeadlineKey) return;
  lastHeadlineKey = headlineKey;

  const fragment = document.createDocumentFragment();
  for (const card of cards) {
    const item = document.createElement("article");
    item.className = `headline-metric headline-${card.kind || "summary"}`;
    const topLine = document.createElement("div");
    topLine.className = "headline-metric-top";
    const label = document.createElement("span");
    label.className = "headline-metric-label";
    label.textContent = card.label;
    const labelCluster = document.createElement("span");
    labelCluster.className = "headline-label-cluster";
    labelCluster.appendChild(label);
    if (card.deltaPulse) {
      const deltaPulse = document.createElement("span");
      deltaPulse.className = "headline-time-delta";
      deltaPulse.textContent = card.deltaPulse.text;
      labelCluster.appendChild(deltaPulse);
    }
    const badge = document.createElement("span");
    badge.className = "headline-live-badge";
    badge.textContent = card.badge || (card.progress === undefined ? "TOTAL" : "LIVE");
    topLine.append(labelCluster, badge);

    const valueRow = document.createElement("div");
    valueRow.className = "headline-metric-value-row";
    const value = document.createElement("strong");
    value.textContent = card.value;
    const unit = document.createElement("span");
    unit.textContent = card.unit;
    valueRow.append(value, unit);
    const detail = document.createElement("span");
    detail.className = "headline-metric-detail";
    detail.textContent = card.detail;
    item.append(topLine, valueRow, detail);
    if (card.subdetail) {
      const subdetail = document.createElement("span");
      subdetail.className = "headline-metric-subdetail";
      subdetail.textContent = card.subdetail;
      item.appendChild(subdetail);
    }
    if (card.progress !== undefined) {
      const progress = document.createElement("div");
      progress.className = "headline-progress";
      const fill = document.createElement("span");
      fill.style.width = `${Math.round(card.progress * 1000) / 10}%`;
      progress.appendChild(fill);
      item.appendChild(progress);
    } else if (card.delta) {
      const delta = document.createElement("span");
      delta.className = `headline-delta delta-${card.delta.tone}`;
      delta.textContent = card.delta.text === "baseline" ? "baseline" : `${card.delta.text} vs prev`;
      item.appendChild(delta);
    }
    fragment.appendChild(item);
  }
  elements.headlineMetricsPanel.replaceChildren(fragment);
}

function emitCompletedTimeDelta(previousTime, nextTime) {
  if (!trace || !replay || nextTime <= previousTime) return;
  const completedEvents = replay.events.filter((event) => event.end > previousTime && event.end <= nextTime);
  const event = completedEvents.at(-1);
  if (!event) return;
  const key = `${event.id}:${event.end}:${performance.now().toFixed(1)}`;
  latestTimeDelta = { text: eventDurationMicroseconds(event, trace), key };
  lastHeadlineKey = "";
  window.setTimeout(() => {
    if (latestTimeDelta?.key !== key) return;
    latestTimeDelta = null;
    lastHeadlineKey = "";
    draw({ forcePanels: true });
  }, 1300);
}

function updateSchedulerModeButtons() {
  const availableSchedulers = new Set([...elements.schedulerSelect.options].map((option) => option.value));
  for (const button of elements.schedulerModeButtons) {
    const scheduler = button.dataset.schedulerMode;
    const active = elements.schedulerSelect.value === scheduler;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
    button.disabled = generationLoading || sourceMode !== "experiment" || !availableSchedulers.has(scheduler);
  }
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

function recordFrame(delta, now = performance.now()) {
  frameTimes.push(delta);
  if (frameTimes.length > 60) frameTimes.shift();
  if (now - lastPerformancePanelRender < PERFORMANCE_PANEL_INTERVAL_MS) return;
  lastPerformancePanelRender = now;
  const average = frameTimes.reduce((sum, item) => sum + item, 0) / Math.max(1, frameTimes.length);
  const fps = average > 0 ? 1000 / average : 0;
  elements.performancePanel.textContent = `FPS: ${fps.toFixed(1)} | events: ${trace?.events.length ?? 0}`;
}

function resetInspectorRenderCache() {
  frameTimes = [];
  lastFrame = performance.now();
  renderedMetricsTrace = null;
  lastMetricsDagKey = "";
  lastHeadlineKey = "";
  lastInitialLayoutKey = "";
  lastDagKey = "";
  lastCircuitKey = "";
  lastExpandedCircuitKey = "";
  lastEventKey = "";
  lastLivePanelRender = 0;
  lastPerformancePanelRender = 0;
  elements.performancePanel.textContent = `FPS: -- | events: ${trace?.events.length ?? 0}`;
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

function focusDagViewport(container) {
  const svg = container.querySelector("svg");
  const target = container.querySelector(".dag-svg-node.active") || container.querySelector(".dag-svg-node.ready");
  if (!svg || !target) return;
  const transform = target.getAttribute("transform") || "";
  const match = /translate\(([-\d.]+),\s*([-\d.]+)\)/.exec(transform);
  if (!match) return;
  const viewBoxHeight = Number(svg.getAttribute("viewBox")?.split(/\s+/)[3] || svg.getAttribute("height") || 1);
  const scale = svg.clientHeight > 0 && viewBoxHeight > 0 ? svg.clientHeight / viewBoxHeight : 1;
  const targetTop = Number(match[2]) * scale - container.clientHeight * 0.32;
  const nextScrollTop = Math.max(0, targetTop);
  if (Math.abs(container.scrollTop - nextScrollTop) > 24) {
    container.scrollTop = nextScrollTop;
  }
  container.scrollLeft = 0;
}

async function fetchJson(path, options = {}) {
  const response = await fetch(path, { signal: options.signal });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (error) {
    if (response.ok) throw error;
    payload = { error: text };
  }
  if (!response.ok) {
    throw new Error(payload?.error || `Failed to load ${path}: ${response.status}`);
  }
  return payload;
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function formatErrorMessage(error) {
  return String(error?.message || error || "Unknown error").replace(/^Error:\s*/, "").split("\n")[0];
}
