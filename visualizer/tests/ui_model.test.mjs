import test from "node:test";
import assert from "node:assert/strict";

import { createMetricCards, describeEvent, summarizeDag } from "../ui_model.js";

test("createMetricCards derives shuttling burden and gate mix for executive metrics", () => {
  const cards = createMetricCards({
    finish_time: 1000,
    event_count: 42,
    one_qubit_gates: 9,
    two_qubit_gates: 5,
    shuttling_time: 250,
    counts: { gate: 14, split: 4, move: 6, merge: 4 },
    times: { gate: 500, split: 80, move: 120, merge: 50 },
  });

  assert.deepEqual(cards.map((card) => card.label), [
    "Finish time",
    "Schedule events",
    "Gate mix",
    "Shuttling burden",
  ]);
  assert.equal(cards[0].value, "1000");
  assert.equal(cards[2].value, "9 / 5");
  assert.equal(cards[3].value, "250");
  assert.equal(cards[3].detail, "aggregate cycles, 25.0% of makespan");
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
