import test from "node:test";
import assert from "node:assert/strict";

import { compareTracePair, createComparisonRows } from "../comparison_model.js";

function trace(overrides = {}) {
  return {
    run: {
      id: overrides.id || "run-a",
      program: overrides.program || "qft_n4.qasm",
      machine: overrides.machine || "G3x3",
      mapper: overrides.mapper || "Greedy",
      scheduler_policy: overrides.scheduler || "EJF",
      seed: overrides.seed ?? 123,
      tie_break_policy: overrides.tieBreak || "stable",
    },
    timing_model: { hash: overrides.timingHash || "timing-v1" },
    metric_model: { hash: overrides.metricHash || "metric-v1" },
    architecture_hash: overrides.architectureHash || "architecture-v1",
    validation: overrides.validation || { valid: true, errors: [] },
    dag: overrides.dag || {
      nodes: [
        { id: 0, gate_name: "h", qubits: [0], arity: 1 },
        { id: 1, gate_name: "cx", qubits: [0, 1], arity: 2 },
      ],
      edges: [{ source: 0, target: 1 }],
    },
    events: [
      { type: "gate", start: 0, end: 10, target: "trap:0", ions: [0], metadata: { gate_id: 0, arity: 1 } },
      { type: "split", start: 10, end: 20, source: "trap:0", target: "segment:0", ions: [0], metadata: { swap_count: 1, ion_hops: 2 } },
      { type: "move", start: 20, end: 30, source: "segment:0", target: "segment:1", ions: [0], metadata: {} },
      { type: "merge", start: 30, end: 40, source: "segment:1", target: "trap:1", ions: [0], metadata: {} },
      {
        type: "gate",
        start: (overrides.finishTime ?? 100) - 10,
        end: overrides.finishTime ?? 100,
        target: "trap:1",
        ions: [0, 1],
        metadata: { gate_id: 1, arity: 2 },
      },
    ],
    metrics: {
      finish_time: overrides.finishTime ?? 100,
      counts: { gate: 2, split: 1, move: 1, merge: 1 },
      swap_count: overrides.swapCount ?? 1,
      ion_hops: overrides.ionHops ?? 2,
      fidelity: overrides.fidelity ?? 0.96,
    },
  };
}

function rowByMetric(rows, metric) {
  return Object.fromEntries(rows.map((row) => [row.metric, row]))[metric];
}

test("createComparisonRows compares compatible traces and marks best values", () => {
  const baseline = trace({ id: "baseline", finishTime: 100, fidelity: 0.96 });
  const candidate = trace({ id: "candidate", finishTime: 80, fidelity: 0.98 });

  const rows = createComparisonRows([baseline, candidate]);

  assert.equal(rowByMetric(rows, "total_time").delta, -20);
  assert.equal(rowByMetric(rows, "total_time").winner, "candidate");
  assert.equal(rowByMetric(rows, "fidelity").winner, "candidate");
  assert.equal(rowByMetric(rows, "channel_pressure").baseline, 40);
  assert.equal(rowByMetric(rows, "dag_stall_time").baseline, 80);
});

test("createComparisonRows recomputes stale event metrics before comparing", () => {
  const baseline = trace({ id: "baseline", finishTime: 100 });
  const candidate = trace({ id: "candidate", finishTime: 80 });
  baseline.metrics.finish_time = 999;
  baseline.metrics.counts = { gate: 2, split: 99, move: 99, merge: 99 };

  const rows = createComparisonRows([baseline, candidate]);

  assert.equal(rowByMetric(rows, "total_time").baseline, 100);
  assert.equal(rowByMetric(rows, "shuttles").baseline, 3);
});

test("compareTracePair reports non-comparable circuit and timing mismatches", () => {
  const baseline = trace();
  const candidate = trace({
    timingHash: "timing-v2",
    dag: {
      nodes: [{ id: 0, gate_name: "h", qubits: [0], arity: 1 }],
      edges: [],
    },
  });

  const result = compareTracePair(baseline, candidate);

  assert.equal(result.status, "non_comparable");
  assert.match(result.reasons.join(" | "), /circuit/);
  assert.match(result.reasons.join(" | "), /timing model/);
});

test("compareTracePair reports non-comparable architecture mismatches", () => {
  const result = compareTracePair(trace({ architectureHash: "architecture-a" }), trace({ architectureHash: "architecture-b" }));

  assert.equal(result.status, "non_comparable");
  assert.match(result.reasons.join(" | "), /architecture/);
});

test("compareTracePair keeps seed and tie-break differences as flags", () => {
  const result = compareTracePair(
    trace({ seed: 1, tieBreak: "stable" }),
    trace({ seed: 2, tieBreak: "random" }),
  );

  assert.equal(result.status, "comparable");
  assert.deepEqual(result.flags, ["seed_mismatch", "tie_break_mismatch"]);
});

test("compareTracePair refuses traces with explicit invalid validation", () => {
  const result = compareTracePair(trace(), {
    ...trace({ id: "candidate" }),
    validation: { valid: false, errors: ["capacity overflow"] },
  });

  assert.equal(result.status, "non_comparable");
  assert.match(result.reasons.join(" | "), /validation failed/);
});

test("compareTracePair requires backend validation to be present and valid", () => {
  const candidate = trace({ id: "candidate" });
  delete candidate.validation;

  const result = compareTracePair(trace(), candidate);

  assert.equal(result.status, "non_comparable");
  assert.match(result.reasons.join(" | "), /validation missing/);
});
