import test from "node:test";
import assert from "node:assert/strict";

import {
  createHeadlineMetricCards,
  createMetricCards,
  createScenarioCopy,
  createValidationSummary,
  describeEvent,
  eventDurationMicroseconds,
  formatMicroseconds,
  playbackDeltaCycles,
  playbackScaleSummary,
  summarizeDag,
} from "../ui_model.js";

test("createMetricCards derives motion burden and gate mix for executive metrics", () => {
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
  assert.equal(cards[3].detail, "split / move / merge events");
  assert.equal(cards[4].value, "3");
  assert.equal(cards[4].detail, "7 swap hops, 11 ion hops");
  assert.equal(cards[5].value, "18");
  assert.equal(cards[5].detail, "blocked DAG ops, 2 ready");
});

test("createHeadlineMetricCards highlights execution, shuttles, and fidelity", () => {
  const cards = createHeadlineMetricCards(
    {
      finish_time: 920,
      shuttling_time: 260,
      fidelity: 0.98765,
      counts: { split: 8, move: 12, merge: 8 },
    },
    {
      finish_time: 1000,
      shuttling_time: 210,
      fidelity: 0.982,
      counts: { split: 6, move: 9, merge: 6 },
    },
  );

  assert.deepEqual(cards.map((card) => card.label), ["Total time", "Shuttles", "Fidelity"]);
  assert.equal(cards[0].value, "920");
  assert.equal(cards[0].unit, "μs");
  assert.deepEqual(cards[0].delta, { text: "-80", tone: "good" });
  assert.equal(cards[1].value, "28");
  assert.equal(cards[1].detail, "8 split | 12 move | 8 merge");
  assert.deepEqual(cards[1].delta, { text: "+7", tone: "bad" });
  assert.equal(cards[2].value, "98.77");
  assert.equal(cards[2].unit, "%");
  assert.equal(cards[2].detail, "estimated end-to-end success");
  assert.deepEqual(cards[2].delta, { text: "+0.57%", tone: "good" });
});

test("createHeadlineMetricCards reports live schedule progress against final totals", () => {
  const cards = createHeadlineMetricCards(
    {
      finish_time: 100,
      shuttling_time: 50,
      fidelity: 0.87,
      counts: { split: 4, move: 6, merge: 4 },
    },
    {
      elapsedTime: 25,
      finishTime: 100,
      shuttlingTime: 12,
      fidelity: 0.95,
      shuttlingOps: 3,
      activeShuttlingOps: 1,
      counts: { split: 1, move: 2, merge: 0 },
    },
  );

  assert.equal(cards[0].value, "25");
  assert.equal(cards[0].unit, "/ 100 μs");
  assert.equal(cards[0].detail, "1000x demo magnification");
  assert.equal(cards[0].progress, 0.25);
  assert.equal(cards[1].value, "3");
  assert.equal(cards[1].unit, "/ 14 ops");
  assert.equal(cards[1].detail, "1 active now");
  assert.equal(cards[1].subdetail, "1 split | 2 move | 0 merge");
  assert.equal(cards[1].progress, 3 / 14);
  assert.equal(cards[2].value, "95.00");
  assert.equal(cards[2].unit, "/ 87.00%");
  assert.equal(cards[2].detail, "estimated from completed operations");
  assert.equal(cards[2].progress, 0.95);
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

test("createValidationSummary reports invalid schedules as blocked with concise reasons", () => {
  const summary = createValidationSummary({
    valid: false,
    errors: [
      "event 17 source trap:2 not adjacent to segment:9",
      "ion 4 busy until 230 for event 18",
      "trap:1 occupancy 3 exceeds capacity 2 after event 19",
      "dag node 22 starts before dependency 21 completes",
    ],
  });

  assert.equal(summary.state, "blocked");
  assert.equal(summary.title, "Schedule blocked");
  assert.equal(
    summary.detail,
    "event 17 source trap:2 not adjacent to segment:9; ion 4 busy until 230 for event 18; trap:1 occupancy 3 exceeds capacity 2 after event 19; +1 more",
  );
});

test("createValidationSummary keeps valid schedules non-intrusive", () => {
  assert.deepEqual(createValidationSummary({ valid: true, errors: [] }), {
    state: "valid",
    title: "Schedule verified",
    detail: "Trace passes topology, dependency, capacity, resource, and endpoint checks.",
    errors: [],
  });
});

test("time formatting converts trace cycles to microseconds", () => {
  const timing = { cycle_time_us: 0.5 };
  assert.equal(formatMicroseconds(80, timing), "40 μs");
  assert.equal(formatMicroseconds(80, timing, { signed: true }), "+40 μs");
  assert.equal(
    eventDurationMicroseconds({ start: 10, end: 90 }, { timing }),
    "+40 μs",
  );
});

test("playbackDeltaCycles preserves real-time ratios through cycle_time_us", () => {
  assert.equal(playbackDeltaCycles(16, 2, { timing: { cycle_time_us: 0.5, display_us_per_ms: 1 } }), 64);
  assert.equal(playbackDeltaCycles(16, 0.5, { timing: { cycle_time_us: 2, display_us_per_ms: 1 } }), 4);
});

test("playbackScaleSummary exposes the demo time magnification", () => {
  assert.deepEqual(playbackScaleSummary(1, { timing: { display_us_per_ms: 1 } }), {
    label: "Time magnification 1000x",
    detail: "1 ms display = 1 μs hardware",
    magnification: 1000,
  });
  assert.equal(playbackScaleSummary(10, { timing: { display_us_per_ms: 1 } }).label, "Time magnification 100x");
});

test("live headline Time card carries magnification and latest operation delta", () => {
  const [timeCard] = createHeadlineMetricCards(
    {
      finish_time: 100,
      shuttling_time: 50,
      counts: { split: 1, move: 0, merge: 1 },
      playback_speed: 2,
      latest_time_delta: "+80 μs",
      latest_time_delta_key: "event-7",
      timing: { cycle_time_us: 1, display_us_per_ms: 1 },
    },
    {
      elapsedTime: 20,
      finishTime: 100,
      shuttlingTime: 8,
      shuttlingOps: 1,
      counts: { split: 1, move: 0, merge: 0 },
    },
  );

  assert.equal(timeCard.badge, "500x");
  assert.equal(timeCard.detail, "500x demo magnification");
  assert.deepEqual(timeCard.deltaPulse, { text: "+80 μs", key: "event-7" });
});

test("live headline Shuttles card carries latest shuttle-count delta", () => {
  const [, shuttleCard] = createHeadlineMetricCards(
    {
      finish_time: 100,
      fidelity: 0.98,
      counts: { split: 2, move: 2, merge: 2 },
      latest_shuttle_delta: "+2",
      latest_shuttle_delta_key: "shuttle-2",
    },
    {
      elapsedTime: 20,
      finishTime: 100,
      fidelity: 0.99,
      shuttlingOps: 3,
      counts: { split: 1, move: 1, merge: 1 },
    },
  );

  assert.deepEqual(shuttleCard.deltaPulse, { text: "+2", key: "shuttle-2" });
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
