import test from "node:test";
import assert from "node:assert/strict";

import { createMetricCards, createScenarioCopy, describeEvent, summarizeDag } from "../ui_model.js";

test("createMetricCards derives shuttling burden and gate mix for executive metrics", () => {
  const cards = createMetricCards({
    finish_time: 1000,
    event_count: 42,
    one_qubit_gates: 9,
    two_qubit_gates: 5,
    shuttling_time: 250,
    swap_count: 3,
    swap_hops: 7,
    ion_hops: 11,
    max_parallel_gates: 4,
    blocked_ops: 18,
    ready_ops: 2,
    counts: { gate: 14, split: 4, move: 6, merge: 4 },
    times: { gate: 500, split: 80, move: 120, merge: 50 },
  });

  assert.deepEqual(cards.map((card) => card.label), [
    "Finish time",
    "Parallel gates",
    "Gate mix",
    "Motion ops",
    "Swap work",
    "DAG pressure",
  ]);
  assert.equal(cards[0].value, "1000");
  assert.equal(cards[1].value, "4");
  assert.equal(cards[2].value, "9 / 5");
  assert.equal(cards[3].value, "4 / 6 / 4");
  assert.equal(cards[3].detail, "split / move / merge, 25.0% shuttle time");
  assert.equal(cards[4].value, "3");
  assert.equal(cards[4].detail, "7 swap hops, 11 ion hops");
  assert.equal(cards[5].value, "18");
  assert.equal(cards[5].detail, "blocked DAG ops, 2 ready");
});

test("createScenarioCopy reflects the active generated trace", () => {
  const copy = createScenarioCopy({
    program: { id: "qaoa_n6", label: "QAOA N6" },
    run: {
      program: "programs/benchmarks/qasmbench/qaoa_n6.qasm",
      machine: "G3x3",
      mapper: "SABRE",
      scheduler_policy: "EJF-GlobalSerial",
    },
  });

  assert.equal(copy.title, "QAOA N6 on G3x3");
  assert.equal(
    copy.description,
    "Replay a QCCDSim trace with SABRE mapping, EJF-GlobalSerial scheduling, ion shuttling, laser gates, and DAG progress.",
  );
});

test("createScenarioCopy falls back to a readable program id", () => {
  const copy = createScenarioCopy({
    run: {
      program: "programs/foo/cat_state_n22.qasm",
      machine: "L6",
    },
  });

  assert.equal(copy.title, "Cat State N22 on L6");
});

test("describeEvent translates trace events into presentation-safe copy", () => {
  assert.equal(
    describeEvent({
      type: "split",
      ions: [2],
      source: "trap:3",
      target: "segment:6",
      start: 235,
      end: 365,
      metadata: { endpoint: "R", swap_count: 1, swap_hops: 2, swap_ions: [2, 5] },
    }),
    "Swap ions 2 and 5 inside T3, then split ion 2 via right endpoint - 130 cycles",
  );

  assert.equal(
    describeEvent({
      type: "gate",
      ions: [0, 1],
      target: "trap:0",
      start: 10,
      end: 18,
      metadata: { gate_name: "cx", arity: 2 },
    }),
    "Apply CX gate on ions 0, 1 in T0 - 8 cycles",
  );
});

test("summarizeDag counts completed active ready and blocked nodes", () => {
  const nodes = new Map([
    [0, { id: 0, state: "completed" }],
    [1, { id: 1, state: "active" }],
    [2, { id: 2, state: "ready" }],
    [3, { id: 3, state: "blocked" }],
    [4, { id: 4, state: "blocked" }],
  ]);

  assert.deepEqual(summarizeDag({ nodes, edges: [{}, {}] }), {
    total: 5,
    completed: 1,
    active: 1,
    ready: 1,
    blocked: 2,
    edges: 2,
  });
}
);
