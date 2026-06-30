import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const cssSource = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const canvasSource = readFileSync(new URL("../canvas_renderer.js", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("desktop demo layout prioritizes the main canvas while keeping the DAG side panel visible", () => {
  assert.match(cssSource, /@media\s*\(max-width:\s*1240px\)/);
  assert.doesNotMatch(cssSource, /@media\s*\(max-width:\s*1360px\)/);
  assert.match(cssSource, /grid-template-columns:\s*clamp\(228px,\s*16vw,\s*260px\)\s+minmax\(640px,\s*1fr\)\s+clamp\(350px,\s*24vw,\s*420px\)/);
  assert.match(cssSource, /grid-template-rows:\s*78px\s+minmax\(0,\s*1fr\)\s+48px/);
  assert.match(cssSource, /\.header-bar\s*{[\s\S]*display:\s*grid;[\s\S]*grid-template-columns:\s*clamp\(228px,\s*16vw,\s*260px\)\s+minmax\(640px,\s*1fr\)/);
  assert.doesNotMatch(indexSource, /scope-pill/);
  assert.doesNotMatch(indexSource, /status-pill/);
  assert.match(cssSource, /\.visualization-viewport\s*{[\s\S]*grid-template-rows:\s*96px\s+minmax\(0,\s*1fr\)/);
});

test("bottom timeline reports gate progress instead of raw cycle time", () => {
  assert.match(indexSource, /id="timeReadout">0 \/ 0 gates</);
  assert.match(appSource, /const\s+dagProgress\s*=\s*summarizeDag\(state\.dagState\)/);
  assert.match(appSource, /elements\.timeReadout\.textContent\s*=\s*`\$\{dagProgress\.completed\} \/ \$\{dagProgress\.total\} gates`/);
  assert.doesNotMatch(appSource, /timeReadout\.textContent\s*=\s*`\$\{Math\.floor\(state\.time\)\}/);
});

test("trace generation ignores stale responses and disables duplicate submissions", () => {
  assert.match(appSource, /let\s+loadRequestId\s*=\s*0/);
  assert.match(appSource, /let\s+activeLoadController\s*=\s*null/);
  assert.match(appSource, /new AbortController\(\)/);
  assert.match(appSource, /function beginLoadRequest\(\)\s*{[\s\S]*?loadRequestId\s*\+=\s*1/);
  assert.match(appSource, /requestId\s*!==\s*loadRequestId/);
  assert.match(appSource, /async function loadTrace\(path\)\s*{[\s\S]*?const\s+\{\s*requestId,\s*signal\s*\}\s*=\s*beginLoadRequest\(\)[\s\S]*?loadTraceData\(nextTrace\)/);
  assert.match(appSource, /function setGenerationLoading\(isLoading\)/);
  assert.match(appSource, /elements\.loadConfigButton\.disabled\s*=\s*generationLoading\s*\|\|\s*sourceMode\s*!==\s*"experiment"/);
  assert.match(appSource, /const GENERATION_LOCKED_ELEMENTS\s*=\s*\[/);
  assert.match(appSource, /elements\.playPauseButton\.disabled\s*=\s*isLoading/);
  assert.match(appSource, /elements\.timeline\.disabled\s*=\s*isLoading/);
  assert.match(appSource, /playing\s*=\s*false/);
  assert.doesNotMatch(appSource, /generatedTraces/);
  assert.doesNotMatch(appSource, /upsertTraceOption/);
});

test("invalid traces are rejected before replay installation", () => {
  const validIndex = appSource.indexOf("const valid = frontendValidation.valid && backendValidation.valid");
  const guardIndex = appSource.indexOf("if (!valid)");
  const replayIndex = appSource.indexOf("const nextReplay = createReplay(nextTrace)");
  assert.ok(validIndex !== -1, "loadTraceData computes merged validation");
  assert.ok(guardIndex > validIndex, "loadTraceData checks merged validation");
  assert.ok(replayIndex > guardIndex, "createReplay runs only after invalid trace guard");
  assert.match(appSource, /showConfigError\(validationErrors\.join\("; "\)\)/);
});

test("large dependency DAGs are rendered without dropping nodes", () => {
  assert.doesNotMatch(appSource, /DAG_MAX_RENDERED_NODES/);
  assert.doesNotMatch(appSource, /maxNodes/);
  assert.match(appSource, /renderDagSvg\(elements\.dagPanel,\s*state\.dagState,\s*\{\s*direction:\s*"vertical"\s*\}\)/);
});

test("responsive DAG panel stays scroll-contained near the desktop breakpoint", () => {
  assert.match(cssSource, /@media\s*\(max-width:\s*1240px\)[\s\S]*#dagPanel\s*{[\s\S]*max-height:\s*min\(560px,\s*60vh\)/);
  assert.match(cssSource, /@media\s*\(max-width:\s*1240px\)[\s\S]*\.dag-page\s*{[\s\S]*height:\s*min\(640px,\s*72vh\)/);
});

test("primary playback controls appear before advanced experiment configuration", () => {
  assert.ok(indexSource.indexOf('class="playback-grid"') < indexSource.indexOf('class="advanced-config"'));
  assert.ok(indexSource.indexOf('for="speedSelect"') < indexSource.indexOf('class="advanced-config"'));
});

test("left control shell stays fixed while experiment configuration scrolls internally", () => {
  assert.match(indexSource, /class="left-fixed-region"/);
  assert.match(indexSource, /id="controlScrollRegion"\s+class="left-scroll-region"/);
  assert.match(cssSource, /\.left-control-panel\s*{[\s\S]*grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)[\s\S]*overflow:\s*hidden/);
  assert.match(cssSource, /\.left-scroll-region\s*{[\s\S]*overflow:\s*auto/);
});

test("scheduler mode buttons cover every exposed demo scheduling mode", () => {
  assert.match(indexSource, /data-scheduler-mode="EJF"/);
  assert.match(indexSource, /data-scheduler-mode="EJF-SerialComm"/);
  assert.match(indexSource, /data-scheduler-mode="EJF-GlobalSerial"/);
  assert.match(appSource, /updateSchedulerModeButtons/);
});

test("scheduler mode regeneration preserves the control panel scroll position", () => {
  assert.match(appSource, /async function loadSelectedConfig\(\{\s*preserveControlScroll\s*=\s*true\s*\}\s*=\s*\{\}\)/);
  assert.match(appSource, /controlScrollRegion:\s*document\.getElementById\("controlScrollRegion"\)/);
  assert.match(appSource, /const controlScrollTop\s*=\s*preserveControlScroll\s*\?\s*getControlScrollTop\(\)\s*:\s*null/);
  assert.match(appSource, /loadTraceData\(nextTrace,\s*\{\s*resetControlPanelScroll:\s*!preserveControlScroll\s*\}\)/);
  assert.match(appSource, /restoreControlScrollTop\(controlScrollTop\)/);
});

test("active laser gates are visually stronger in the DAG and circuit strip", () => {
  assert.match(cssSource, /\.dag-svg-node\.active\s+rect\s*{[\s\S]*stroke-width:\s*3/);
  assert.match(cssSource, /\.dag-svg-node\.active\s+rect\s*{[\s\S]*filter:\s*drop-shadow/);
  assert.match(cssSource, /\.circuit-gate\.active\s+rect,[\s\S]*\.circuit-gate\.active\s+\.circuit-target,[\s\S]*\.circuit-gate\.active\s+\.circuit-control\s*{[\s\S]*stroke-width:\s*2/);
  assert.match(cssSource, /\.circuit-gate\.active\s+text\s*{[\s\S]*fill:\s*#ffffff/);
});

test("verified trace and generated experiment are explicit mutually exclusive replay sources", () => {
  assert.match(indexSource, /class="source-mode-toggle"/);
  assert.match(indexSource, /data-source-mode="trace"/);
  assert.match(indexSource, /data-source-mode="experiment"/);
  assert.match(appSource, /let\s+sourceMode\s*=\s*"experiment"/);
  assert.match(appSource, /function setSourceMode\(mode/);
  assert.match(appSource, /elements\.traceSelect\.disabled\s*=\s*generationLoading\s*\|\|\s*sourceMode\s*!==\s*"trace"/);
  assert.match(appSource, /elements\.loadConfigButton\.disabled\s*=\s*generationLoading\s*\|\|\s*sourceMode\s*!==\s*"experiment"/);
});

test("main hardware viewport contains a synchronized TikZ-style circuit strip above the canvas", () => {
  assert.ok(indexSource.indexOf('id="circuitPanel"') < indexSource.indexOf('id="vizCanvas"'));
  assert.match(appSource, /import\s+\{\s*renderCircuitSvg\s*\}\s+from\s+"\.\/circuit_renderer\.js/);
  assert.match(appSource, /renderCircuitSvg\(elements\.circuitPanel,\s*state\.dagState/);
  assert.match(cssSource, /\.circuit-strip/);
  assert.match(cssSource, /\.circuit-svg/);
});

test("circuit strip exposes an expanded synchronized circuit view", () => {
  assert.match(indexSource, /id="circuitExpandButton"/);
  assert.match(indexSource, /id="circuitDialog"/);
  assert.match(indexSource, /id="circuitDialogPanel"/);
  assert.match(appSource, /function openCircuitDialog\(\)/);
  assert.match(appSource, /renderCircuitSvg\(elements\.circuitDialogPanel,\s*state\.dagState/);
  assert.match(cssSource, /\.circuit-dialog\[hidden\]/);
  assert.match(cssSource, /\.circuit-dialog-panel/);
});

test("ion rendering uses a luminous shell instead of a flat billiard-ball treatment", () => {
  assert.match(canvasSource, /function drawIonBody/);
  assert.match(canvasSource, /createRadialGradient/);
  assert.match(canvasSource, /globalCompositeOperation\s*=\s*"screen"/);
});

test("right inspector is dedicated to the full-height dependency DAG", () => {
  assert.doesNotMatch(indexSource, /Timeline focus/);
  assert.doesNotMatch(indexSource, /Schedule metrics/);
  assert.doesNotMatch(indexSource, /Initial ion chains/);
  assert.match(cssSource, /\.right-inspector-panel\s*{[\s\S]*grid-template-rows:\s*minmax\(0,\s*1fr\)/);
});

test("mobile layout surfaces the animation before form controls", () => {
  assert.match(cssSource, /@media\s*\(max-width:\s*760px\)[\s\S]*grid-template-areas:\s*"header"\s*"viewport"\s*"timeline"\s*"left"\s*"right"/);
});

test("mobile headline metrics use an internal horizontal rail instead of cramped columns", () => {
  assert.match(cssSource, /@media\s*\(max-width:\s*760px\)[\s\S]*body\s*{[\s\S]*overflow-x:\s*hidden/);
  assert.match(cssSource, /@media\s*\(max-width:\s*760px\)[\s\S]*\.visualization-viewport,\s*[\s\S]*\.left-control-panel,\s*[\s\S]*\.right-inspector-panel,\s*[\s\S]*\.bottom-timeline\s*{[\s\S]*min-width:\s*0/);
  assert.match(cssSource, /@media\s*\(max-width:\s*760px\)[\s\S]*\.header-meta\s*{[\s\S]*max-width:\s*100%/);
  assert.match(cssSource, /@media\s*\(max-width:\s*760px\)[\s\S]*\.headline-metrics\s*{[\s\S]*display:\s*flex/);
  assert.match(cssSource, /@media\s*\(max-width:\s*760px\)[\s\S]*\.headline-metrics\s*{[\s\S]*max-width:\s*100%/);
  assert.match(cssSource, /@media\s*\(max-width:\s*760px\)[\s\S]*\.headline-metrics\s*{[\s\S]*overflow-x:\s*auto/);
  assert.match(cssSource, /@media\s*\(max-width:\s*760px\)[\s\S]*\.headline-metric\s*{[\s\S]*flex:\s*0\s+0\s+205px/);
});

test("infeasible circuit and capacity combinations are caught before generation", () => {
  assert.match(appSource, /machineTrapCounts\s*=\s*new Map/);
  assert.match(appSource, /selectedCapacityFeasibility/);
  assert.match(appSource, /recommended_l6_min_capacity/);
  assert.match(appSource, /recommendedCapacity/);
  assert.match(appSource, /Capacity too small/);
  assert.match(appSource, /needs cap \$\{requiredCapacity\}\+ on \$\{machine\}/);
});

test("demo errors are presented without exposing JavaScript stack traces", () => {
  assert.match(appSource, /formatErrorMessage\(error\)/);
  assert.doesNotMatch(appSource, /error\.stack/);
});

test("live HUD text updates are throttled separately from canvas animation", () => {
  assert.match(appSource, /LIVE_PANEL_INTERVAL_MS/);
  assert.match(appSource, /PERFORMANCE_PANEL_INTERVAL_MS/);
  assert.match(appSource, /frameTimes\s*=\s*\[\]/);
});

test("DAG viewport follows active work before ready work during playback", () => {
  assert.match(
    appSource,
    /container\.querySelector\("\.dag-svg-node\.active"\)\s*\|\|\s*container\.querySelector\("\.dag-svg-node\.ready"\)/,
  );
});

test("window resize invalidates the DAG render cache for responsive relayout", () => {
  assert.match(appSource, /window\.addEventListener\("resize",\s*\(\)\s*=>\s*{[\s\S]*lastDagKey\s*=\s*""[\s\S]*draw\(\)/);
});

test("window resize and circuit panel dimensions invalidate the circuit render cache", () => {
  assert.match(appSource, /lastCircuitKey\s*=\s*""/);
  assert.match(appSource, /const circuitSizeKey\s*=\s*`\$\{elements\.circuitPanel\.clientWidth\}x\$\{elements\.circuitPanel\.clientHeight\}`/);
  assert.match(appSource, /const circuitKey\s*=\s*`\$\{dagKey\}\|\$\{trace\?\.particles\?\.length \?\? 0\}\|\$\{circuitSizeKey\}`/);
});

test("playback speed is a uniform multiplier without active-motion-dependent rescaling", () => {
  assert.doesNotMatch(appSource, /playbackMotionScale/);
  assert.doesNotMatch(appSource, /MIN_MOTION_DISPLAY_CYCLES/);
  assert.match(
    appSource,
    /currentTime\s*=\s*Math\.min\(replay\.finishTime,\s*currentTime\s*\+\s*delta\s*\*\s*Number\(elements\.speedSelect\.value\)\)/,
  );
});
