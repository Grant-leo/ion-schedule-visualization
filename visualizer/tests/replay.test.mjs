import test from "node:test";
import assert from "node:assert/strict";

import { createReplay, validateTrace } from "../replay.js";

const trace = {
  schema_version: "1.0",
  device_type: "ion_trap",
  topology: {
    traps: [
      { id: 0, capacity: 3, slots: [0, 1, 2], orientation: { 0: "R" } },
      { id: 1, capacity: 3, slots: [0, 1, 2], orientation: { 0: "L" } },
    ],
    segments: [{ id: 0, from: "trap:0", to: "trap:1", length: 10 }],
    junctions: [],
  },
  dag: {
    nodes: [
      { id: 0, gate_name: "h", qubits: [0], arity: 1 },
      { id: 1, gate_name: "cx", qubits: [0, 1], arity: 2 },
      { id: 2, gate_name: "x", qubits: [1], arity: 1 },
    ],
    edges: [
      { source: 0, target: 1 },
      { source: 1, target: 2 },
    ],
  },
  particles: [
    { id: 0, initial_location: "trap:0", initial_slot: 0 },
    { id: 1, initial_location: "trap:0", initial_slot: 1 },
  ],
  events: [
    {
      id: 0,
      type: "gate",
      start: 0,
      end: 5,
      ions: [1],
      source: "trap:0",
      target: "trap:0",
      metadata: { gate_id: 0, gate_name: "h", arity: 1 },
    },
    {
      id: 1,
      type: "split",
      start: 10,
      end: 20,
      ions: [0],
      source: "trap:0",
      target: "segment:0",
      metadata: { endpoint: "R" },
    },
    {
      id: 2,
      type: "merge",
      start: 20,
      end: 30,
      ions: [0],
      source: "segment:0",
      target: "trap:1",
      metadata: { endpoint: "L" },
    },
  ],
  metrics: { event_count: 3 },
};

test("validateTrace accepts a valid motion trace", () => {
  assert.equal(validateTrace(trace).valid, true);
});

test("replay returns correct locations before and after motion", () => {
  const replay = createReplay(trace, 1);

  assert.equal(replay.stateAt(0).locations.get(0), "trap:0");
  assert.equal(replay.stateAt(20).locations.get(0), "segment:0");
  assert.equal(replay.stateAt(30).locations.get(0), "trap:1");
});

test("replay reports active events for in-flight animation", () => {
  const replay = createReplay(trace, 1);
  const active = replay.stateAt(15).activeEvents;

  assert.equal(active.length, 1);
  assert.equal(active[0].type, "split");
});

test("replay keyframes do not move a long parallel shuttle before it ends", () => {
  const parallelTrace = structuredClone(trace);
  parallelTrace.topology.traps = [
    { id: 0, capacity: 1, slots: [0], orientation: { 0: "R" } },
    { id: 1, capacity: 1, slots: [0], orientation: { 1: "R" } },
  ];
  parallelTrace.topology.segments = [
    { id: 0, from: "trap:0", to: "junction:0", length: 10 },
    { id: 1, from: "trap:1", to: "junction:1", length: 10 },
  ];
  parallelTrace.topology.junctions = [{ id: 0 }, { id: 1 }];
  parallelTrace.particles = [
    { id: 0, initial_location: "trap:0", initial_slot: 0 },
    { id: 1, initial_location: "trap:1", initial_slot: 0 },
  ];
  parallelTrace.events = [
    {
      id: 0,
      type: "split",
      start: 0,
      end: 100,
      ions: [0],
      source: "trap:0",
      target: "segment:0",
      metadata: { endpoint: "R" },
    },
    {
      id: 1,
      type: "split",
      start: 1,
      end: 2,
      ions: [1],
      source: "trap:1",
      target: "segment:1",
      metadata: { endpoint: "R" },
    },
  ];
  parallelTrace.metrics = { event_count: 2 };

  const replay = createReplay(parallelTrace, 1);
  const state = replay.stateAt(50);

  assert.equal(state.locations.get(0), "trap:0");
  assert.equal(state.locations.get(1), "segment:1");
  assert.deepEqual(
    state.activeEvents.map((event) => event.id),
    [0],
  );
});

test("replay reports live cumulative schedule progress at the current time", () => {
  const replay = createReplay(trace, 1);
  const progress = replay.stateAt(25).progressMetrics;

  assert.equal(progress.finishTime, 30);
  assert.equal(progress.elapsedTime, 25);
  assert.equal(progress.shuttlingTime, 15);
  assert.equal(progress.shuttlingOps, 2);
  assert.equal(progress.activeShuttlingOps, 1);
  assert.deepEqual(progress.counts, { gate: 1, split: 1, move: 0, merge: 1 });
  assert.deepEqual(progress.times, { gate: 5, split: 10, move: 0, merge: 5 });
});

test("validateTrace rejects motion from a stale source", () => {
  const badTrace = structuredClone(trace);
  badTrace.events[1] = {
    ...badTrace.events[1],
    source: "trap:1",
  };

  const validation = validateTrace(badTrace);

  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /not at trap:1/);
});

test("validateTrace rejects shuttling that skips topology adjacency", () => {
  const badTrace = structuredClone(trace);
  badTrace.topology.segments = [
    { id: 0, from: "trap:0", to: "junction:0", length: 10 },
    { id: 1, from: "junction:0", to: "trap:1", length: 10 },
    { id: 2, from: "junction:1", to: "trap:2", length: 10 },
  ];
  badTrace.topology.traps.push({ id: 2, capacity: 3, slots: [0, 1, 2], orientation: { 2: "L" } });
  badTrace.topology.junctions = [{ id: 0 }, { id: 1 }];
  badTrace.events = [
    {
      id: 0,
      type: "split",
      start: 0,
      end: 10,
      ions: [0],
      source: "trap:0",
      target: "segment:0",
      metadata: { endpoint: "R" },
    },
    {
      id: 1,
      type: "move",
      start: 10,
      end: 20,
      ions: [0],
      source: "segment:0",
      target: "segment:2",
      metadata: {},
    },
  ];
  badTrace.metrics = { event_count: 2 };

  const validation = validateTrace(badTrace);

  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /not adjacent to segment:2/);
});

test("validateTrace rejects dynamic trap capacity overflow after merge", () => {
  const badTrace = structuredClone(trace);
  badTrace.topology.traps = [
    { id: 0, capacity: 1, slots: [0], orientation: { 0: "R" } },
    { id: 1, capacity: 1, slots: [0], orientation: { 0: "L" } },
  ];
  badTrace.particles = [
    { id: 0, initial_location: "trap:0", initial_slot: 0 },
    { id: 1, initial_location: "trap:1", initial_slot: 0 },
  ];
  badTrace.events = [
    {
      id: 0,
      type: "split",
      start: 0,
      end: 10,
      ions: [0],
      source: "trap:0",
      target: "segment:0",
      metadata: { endpoint: "R" },
    },
    {
      id: 1,
      type: "merge",
      start: 10,
      end: 20,
      ions: [0],
      source: "segment:0",
      target: "trap:1",
      metadata: { endpoint: "L" },
    },
  ];
  badTrace.metrics = { event_count: 2 };

  const validation = validateTrace(badTrace);

  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /trap:1 occupancy 2 exceeds capacity 1/);
});

test("validateTrace rejects two-qubit gates when ions are not colocated", () => {
  const badTrace = {
    ...trace,
    particles: [
      { id: 0, initial_location: "trap:0" },
      { id: 1, initial_location: "trap:1" },
    ],
    events: [
      {
        id: 0,
        type: "gate",
        start: 0,
        end: 10,
        ions: [0, 1],
        source: "trap:0",
        target: "trap:0",
        metadata: { arity: 2 },
      },
    ],
  };

  const validation = validateTrace(badTrace);

  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /not at trap:0/);
});

test("validateTrace rejects overlapping events for the same ion", () => {
  const badTrace = structuredClone(trace);
  badTrace.events[2] = {
    ...badTrace.events[2],
    start: 15,
    end: 30,
  };

  const validation = validateTrace(badTrace);

  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /busy until 20/);
});

test("validateTrace rejects overlapping operations on the same trap", () => {
  const badTrace = structuredClone(trace);
  badTrace.events = [
    {
      id: 0,
      type: "gate",
      start: 0,
      end: 10,
      ions: [0],
      source: "trap:0",
      target: "trap:0",
      metadata: { arity: 1 },
    },
    {
      id: 1,
      type: "gate",
      start: 5,
      end: 15,
      ions: [1],
      source: "trap:0",
      target: "trap:0",
      metadata: { arity: 1 },
    },
  ];

  const validation = validateTrace(badTrace);

  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /trap:0 busy until 10/);
});

test("nextEventTime advances to the next event start", () => {
  const replay = createReplay(trace, 1);

  assert.equal(replay.nextEventTime(0), 10);
  assert.equal(replay.nextEventTime(10), 20);
});

test("replay returns trap chains with active split ions removed from the chain", () => {
  const replay = createReplay(trace, 1);

  assert.deepEqual(replay.stateAt(0).trapChains.get("trap:0"), [0, 1]);
  assert.deepEqual(replay.stateAt(15).trapChains.get("trap:0"), [1]);
});

test("replay exposes active internal swaps before endpoint shuttling", () => {
  const swapTrace = structuredClone(trace);
  swapTrace.events[1] = {
    ...swapTrace.events[1],
    metadata: {
      endpoint: "R",
      swap_count: 1,
      swap_hops: 2,
      swap_ions: [0, 1],
    },
  };

  const replay = createReplay(swapTrace, 1);
  const active = replay.stateAt(15).activeEvents[0];

  assert.equal(active.type, "split");
  assert.equal(active.metadata.swap_count, 1);
  assert.deepEqual(active.metadata.swap_ions, [0, 1]);
});

test("replay summarizes swap and parallel gate metrics when trace metrics are stale", () => {
  const metricsTrace = structuredClone(trace);
  metricsTrace.particles = [
    { id: 0, initial_location: "trap:0", initial_slot: 0 },
    { id: 1, initial_location: "trap:1", initial_slot: 0 },
  ];
  metricsTrace.events = [
    {
      id: 0,
      type: "gate",
      start: 0,
      end: 5,
      ions: [0],
      source: "trap:0",
      target: "trap:0",
      metadata: { gate_id: 0, gate_name: "h", arity: 1 },
    },
    {
      id: 1,
      type: "gate",
      start: 0,
      end: 5,
      ions: [1],
      source: "trap:1",
      target: "trap:1",
      metadata: { gate_id: 2, gate_name: "x", arity: 1 },
    },
    {
      id: 2,
      type: "split",
      start: 10,
      end: 20,
      ions: [0],
      source: "trap:0",
      target: "segment:0",
      metadata: { endpoint: "R", swap_count: 2, swap_hops: 3, ion_hops: 4 },
    },
  ];

  const replay = createReplay(metricsTrace, 1);
  const metrics = replay.stateAt(0).metrics;

  assert.equal(metrics.maxParallelGates, 2);
  assert.equal(metrics.crossTrapParallelGates, 2);
  assert.equal(metrics.sameTrapGateOverlaps, 0);
  assert.equal(metrics.swapCount, 2);
  assert.equal(metrics.swapHops, 3);
  assert.equal(metrics.ionHops, 4);
});

test("replay derives dependency graph node states from gate completion", () => {
  const replay = createReplay(trace, 1);

  assert.equal(replay.stateAt(2).dagState.nodes.get(0).state, "active");
  assert.equal(replay.stateAt(6).dagState.nodes.get(0).state, "completed");
  assert.equal(replay.stateAt(6).dagState.nodes.get(1).state, "ready");
  assert.equal(replay.stateAt(6).dagState.nodes.get(2).state, "blocked");
});
