import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { dagGeometryCacheKey, layoutDag } from "../dag_renderer.js";
import { createReplay } from "../replay.js";

if (isMainModule()) {
  const args = parseArgs(process.argv.slice(2));
  await main(args);
}

async function main(args) {
  if (!args["base-url"]) {
    console.log("performance_smoke: skipped; pass --base-url to measure a running visualizer server");
    return;
  }
  const report = await runPerformanceSmoke(args);
  validatePerformanceReport(report);
  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(report, null, 2));
}

export async function runPerformanceSmoke(options) {
  const benchmark = options.benchmark || "dnn_n16";
  const trace = await fetchTrace(options["base-url"], {
    program: benchmark,
    machine: options.machine || "G3x3",
    capacity: options.capacity || "3",
    mapper: options.mapper || "SABRE",
    ordering: options.ordering || "Naive",
    scheduler: options.scheduler || "EJF",
  });
  const replay = createReplay(trace, 100);
  const initialState = replay.stateAt(0);
  const layoutOptions = { width: Number(options.width || 420), height: Number(options.height || 620), direction: "vertical", zoom: 1 };

  const layoutStart = performance.now();
  const graph = layoutDag(initialState.dagState, layoutOptions);
  const initialLayoutMs = performance.now() - layoutStart;

  const baseGeometryKey = dagGeometryCacheKey(initialState.dagState, layoutOptions);
  const tickCount = Number(options.ticks || 60);
  const heapBefore = memoryUsed();
  const tickStart = performance.now();
  let stableGeometryKey = true;
  for (let index = 0; index < tickCount; index += 1) {
    const time = replay.finishTime * (index / Math.max(1, tickCount - 1));
    const state = replay.stateAt(time);
    stableGeometryKey &&= dagGeometryCacheKey(state.dagState, layoutOptions) === baseGeometryKey;
  }
  const perTickUpdateMs = (performance.now() - tickStart) / tickCount;
  const heapGrowthBytes = memoryUsed() - heapBefore;

  const zoomStart = performance.now();
  const zoomGraph = layoutDag(initialState.dagState, { ...layoutOptions, zoom: 1.25 });
  const resizeZoomRecomputeMs = performance.now() - zoomStart;

  return {
    benchmark,
    trace_hash: trace.trace_hash,
    dag_node_count: trace.dag?.nodes?.length || 0,
    rendered_node_count: graph.nodes.length,
    edge_count: graph.edges.length,
    initial_layout_ms: round(initialLayoutMs),
    per_tick_update_ms: round(perTickUpdateMs),
    resize_zoom_recompute_ms: round(resizeZoomRecomputeMs),
    heap_growth_bytes: heapGrowthBytes,
    geometry_key_stable_across_ticks: stableGeometryKey,
    zoom_changes_geometry: zoomGraph.width !== graph.width || zoomGraph.height !== graph.height,
  };
}

export function validatePerformanceReport(report) {
  requireNonnegativeFinite(report.dag_node_count, "dag_node_count");
  requireNonnegativeFinite(report.rendered_node_count, "rendered_node_count");
  requireNonnegativeFinite(report.edge_count, "edge_count");
  requireNonnegativeFinite(report.initial_layout_ms, "initial_layout_ms");
  requireNonnegativeFinite(report.per_tick_update_ms, "per_tick_update_ms");
  requireNonnegativeFinite(report.resize_zoom_recompute_ms, "resize_zoom_recompute_ms");
  requireFinite(report.heap_growth_bytes, "heap_growth_bytes");
  if (report.rendered_node_count !== report.dag_node_count) {
    throw new Error(`DAG rendered ${report.rendered_node_count} of ${report.dag_node_count} nodes`);
  }
  if (report.geometry_key_stable_across_ticks !== true) {
    throw new Error("geometry_key_stable_across_ticks must be true");
  }
  if (report.zoom_changes_geometry !== true) {
    throw new Error("zoom_changes_geometry must be true");
  }
}

async function fetchTrace(baseUrl, params) {
  const url = new URL("/api/trace", baseUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Trace request failed with HTTP ${response.status}`);
  return payload;
}

function parseArgs(items) {
  const result = {};
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = items[index + 1];
    if (next && !next.startsWith("--")) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

function memoryUsed() {
  return typeof process.memoryUsage === "function" ? process.memoryUsage().heapUsed : 0;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function requireNonnegativeFinite(value, field) {
  if (!Number.isFinite(Number(value)) || Number(value) < 0) {
    throw new Error(`${field} must be a nonnegative finite number`);
  }
}

function requireFinite(value, field) {
  if (!Number.isFinite(Number(value))) {
    throw new Error(`${field} must be a finite number`);
  }
}

function isMainModule() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}
