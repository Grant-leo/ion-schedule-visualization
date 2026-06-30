import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const cssSource = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

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
  assert.match(appSource, /const GENERATED_TRACE_LIMIT\s*=\s*12/);
  assert.match(appSource, /while\s*\(generatedTraces\.size\s*>\s*GENERATED_TRACE_LIMIT\)/);
});

test("large dependency DAGs are rendered without dropping nodes", () => {
  assert.doesNotMatch(appSource, /DAG_MAX_RENDERED_NODES/);
  assert.doesNotMatch(appSource, /maxNodes/);
  assert.match(appSource, /renderDagSvg\(elements\.dagPanel,\s*state\.dagState,\s*\{\s*direction:\s*"vertical"\s*\}\)/);
});

test("mobile layout surfaces the animation before form controls", () => {
  assert.match(cssSource, /@media\s*\(max-width:\s*760px\)[\s\S]*grid-template-areas:\s*"header"\s*"viewport"\s*"timeline"\s*"left"\s*"right"/);
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
