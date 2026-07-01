import test from "node:test";
import assert from "node:assert/strict";

import { validatePerformanceReport } from "./performance_smoke.mjs";

test("performance smoke validates numeric timing fields and full DAG coverage", () => {
  const report = {
    benchmark: "dnn_n16",
    trace_hash: "trace",
    dag_node_count: 4064,
    rendered_node_count: 4064,
    edge_count: 4432,
    initial_layout_ms: 12.5,
    per_tick_update_ms: 2.4,
    resize_zoom_recompute_ms: 9.1,
    heap_growth_bytes: 1024,
    geometry_key_stable_across_ticks: true,
    zoom_changes_geometry: true,
  };

  assert.doesNotThrow(() => validatePerformanceReport(report));
});

test("performance smoke rejects missing timing data", () => {
  assert.throws(
    () => validatePerformanceReport({
      dag_node_count: 4,
      rendered_node_count: 4,
      edge_count: 3,
      per_tick_update_ms: 1,
      resize_zoom_recompute_ms: 1,
      heap_growth_bytes: 0,
      geometry_key_stable_across_ticks: true,
      zoom_changes_geometry: true,
    }),
    /initial_layout_ms/,
  );
});

test("performance smoke accepts negative heap deltas after garbage collection", () => {
  assert.doesNotThrow(() => validatePerformanceReport({
    dag_node_count: 4,
    rendered_node_count: 4,
    edge_count: 3,
    initial_layout_ms: 1,
    per_tick_update_ms: 1,
    resize_zoom_recompute_ms: 1,
    heap_growth_bytes: -256,
    geometry_key_stable_across_ticks: true,
    zoom_changes_geometry: true,
  }));
});

test("performance smoke rejects dropped DAG nodes", () => {
  assert.throws(
    () => validatePerformanceReport({
      dag_node_count: 4,
      rendered_node_count: 3,
      edge_count: 3,
      initial_layout_ms: 1,
      per_tick_update_ms: 1,
      resize_zoom_recompute_ms: 1,
      heap_growth_bytes: 0,
      geometry_key_stable_across_ticks: true,
      zoom_changes_geometry: true,
    }),
    /DAG rendered 3 of 4 nodes/,
  );
});
