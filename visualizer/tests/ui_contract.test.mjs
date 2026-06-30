import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const cssSource = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("desktop demo layout keeps the DAG side panel visible at common 1280px widths", () => {
  assert.match(cssSource, /@media\s*\(max-width:\s*1240px\)/);
  assert.doesNotMatch(cssSource, /@media\s*\(max-width:\s*1360px\)/);
  assert.match(cssSource, /grid-template-columns:\s*clamp\(248px,\s*18vw,\s*288px\)\s+minmax\(560px,\s*1fr\)\s+clamp\(380px,\s*28vw,\s*460px\)/);
});

test("trace generation ignores stale responses and disables duplicate submissions", () => {
  assert.match(appSource, /let\s+loadRequestId\s*=\s*0/);
  assert.match(appSource, /let\s+activeLoadController\s*=\s*null/);
  assert.match(appSource, /new AbortController\(\)/);
  assert.match(appSource, /function beginLoadRequest\(\)\s*{[\s\S]*?loadRequestId\s*\+=\s*1/);
  assert.match(appSource, /requestId\s*!==\s*loadRequestId/);
  assert.match(appSource, /async function loadTrace\(path\)\s*{[\s\S]*?const\s+\{\s*requestId,\s*signal\s*\}\s*=\s*beginLoadRequest\(\)[\s\S]*?loadTraceData\(nextTrace\)/);
  assert.match(appSource, /generatedTraces\.has\(value\)[\s\S]*?beginLoadRequest\(\)[\s\S]*?loadTraceData\(generatedTraces\.get\(value\)\)/);
  assert.match(appSource, /function setGenerationLoading\(isLoading\)/);
  assert.match(appSource, /elements\.loadConfigButton\.disabled\s*=\s*isLoading/);
  assert.match(appSource, /const GENERATION_LOCKED_ELEMENTS\s*=\s*\[/);
  assert.match(appSource, /elements\.playPauseButton\.disabled\s*=\s*isLoading/);
  assert.match(appSource, /elements\.timeline\.disabled\s*=\s*isLoading/);
  assert.match(appSource, /playing\s*=\s*false/);
  assert.match(appSource, /const GENERATED_TRACE_LIMIT\s*=\s*12/);
  assert.match(appSource, /while\s*\(generatedTraces\.size\s*>\s*GENERATED_TRACE_LIMIT\)/);
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
