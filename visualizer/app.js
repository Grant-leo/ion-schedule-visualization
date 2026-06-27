import { createRenderer } from "./canvas_renderer.js";
import { createReplay, validateTrace } from "./replay.js";

const elements = {
  traceSelect: document.getElementById("traceSelect"),
  playPauseButton: document.getElementById("playPauseButton"),
  restartButton: document.getElementById("restartButton"),
  stepButton: document.getElementById("stepButton"),
  speedSelect: document.getElementById("speedSelect"),
  timeline: document.getElementById("timeline"),
  canvas: document.getElementById("vizCanvas"),
  metricsPanel: document.getElementById("metricsPanel"),
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

init().catch((error) => {
  elements.validationPanel.textContent = "Load failed";
  elements.validationPanel.classList.add("is-invalid");
  elements.eventPanel.textContent = error.stack || String(error);
});

async function init() {
  const manifest = await fetchJson("traces/manifest.json");
  populateTraceSelector(manifest);
  wireControls();

  if (manifest.length > 0) {
    await loadTrace(manifest[0].path);
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

function wireControls() {
  elements.traceSelect.addEventListener("change", () => loadTrace(elements.traceSelect.value));
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

  const valid = frontendValidation.valid && backendValidation.valid;
  elements.validationPanel.textContent = valid ? "Valid trace" : "Invalid trace";
  elements.validationPanel.classList.toggle("is-valid", valid);
  elements.validationPanel.classList.toggle("is-invalid", !valid);
  draw();
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
