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
      metadata: { endpoint: "R", swap_count: 1, swap_hops: 1, swap_ions: [0, 1] },
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
    {
      id: 3,
      type: "split",
      start: 30,
      end: 40,
      ions: [1],
      source: "trap:0",
      target: "segment:0",
      metadata: { endpoint: "R" },
    },
    {
      id: 4,
      type: "merge",
      start: 40,
      end: 50,
      ions: [1],
      source: "segment:0",
      target: "trap:1",
      metadata: { endpoint: "L" },
    },
    {
      id: 5,
      type: "gate",
      start: 50,
      end: 60,
      ions: [0, 1],
      source: "trap:1",
      target: "trap:1",
      metadata: { gate_id: 1, gate_name: "cx", arity: 2 },
    },
    {
      id: 6,
      type: "gate",
      start: 60,
      end: 65,
      ions: [1],
      source: "trap:1",
      target: "trap:1",
      metadata: { gate_id: 2, gate_name: "x", arity: 1 },
    },
  ],
  metrics: { event_count: 7 },
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
  parallelTrace.dag = { nodes: [], edges: [] };

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

  assert.equal(progress.finishTime, 65);
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

test("validateTrace rejects overlapping use of the same channel segment", () => {
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
      type: "split",
      start: 5,
      end: 15,
      ions: [1],
      source: "trap:1",
      target: "segment:0",
      metadata: { endpoint: "L" },
    },
  ];
  badTrace.metrics = { event_count: 2 };

  const validation = validateTrace(badTrace);

  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /segment:0 busy until 10/);
});

test("validateTrace rejects overlapping crossings through the same junction", () => {
  const badTrace = {
    schema_version: "1.0",
    device_type: "ion_trap",
    topology: {
      traps: Array.from({ length: 4 }, (_, id) => ({ id, capacity: 1, slots: [0] })),
      segments: [
        { id: 0, from: "trap:0", to: "junction:0", length: 10 },
        { id: 1, from: "junction:0", to: "trap:1", length: 10 },
        { id: 2, from: "trap:2", to: "junction:0", length: 10 },
        { id: 3, from: "junction:0", to: "trap:3", length: 10 },
      ],
      junctions: [{ id: 0 }],
    },
    particles: [
      { id: 0, initial_location: "segment:0" },
      { id: 1, initial_location: "segment:2" },
    ],
    events: [
      {
        id: 0,
        type: "move",
        start: 0,
        end: 10,
        ions: [0],
        source: "segment:0",
        target: "segment:1",
        metadata: {},
      },
      {
        id: 1,
        type: "move",
        start: 5,
        end: 15,
        ions: [1],
        source: "segment:2",
        target: "segment:3",
        metadata: {},
      },
    ],
    metrics: { event_count: 2 },
  };

  const validation = validateTrace(badTrace);

  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /junction:0 busy until 10/);
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

test("validateTrace rejects splitting a non-endpoint ion without internal swaps", () => {
  const badTrace = structuredClone(trace);
  badTrace.events[1].metadata = { endpoint: "R" };

  const validation = validateTrace(badTrace);

  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /split ion 0 is not at R endpoint of trap:0/);
});

test("validateTrace rejects internal split metadata that cannot move the ion to the endpoint", () => {
  const badTrace = structuredClone(trace);
  badTrace.events[1].metadata = { endpoint: "R", swap_count: 1, swap_hops: 0, swap_ions: [0, 1] };

  const validation = validateTrace(badTrace);

  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /needs 1 swap hops/);
});

test("validateTrace rejects two-qubit gates when ions are not colocated", () => {
  const badTrace = {
    ...trace,
    dag: { nodes: [{ id: 0, gate_name: "cx", qubits: [0, 1], arity: 2 }], edges: [] },
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
        metadata: { gate_id: 0, arity: 2 },
      },
    ],
    metrics: { event_count: 1 },
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
  badTrace.dag = {
    nodes: [
      { id: 0, gate_name: "h", qubits: [0], arity: 1 },
      { id: 1, gate_name: "x", qubits: [1], arity: 1 },
    ],
    edges: [],
  };
  badTrace.events = [
    {
      id: 0,
      type: "gate",
      start: 0,
      end: 10,
      ions: [0],
      source: "trap:0",
      target: "trap:0",
      metadata: { gate_id: 0, arity: 1 },
    },
    {
      id: 1,
      type: "gate",
      start: 5,
      end: 15,
      ions: [1],
      source: "trap:0",
      target: "trap:0",
      metadata: { gate_id: 1, arity: 1 },
    },
  ];
  badTrace.metrics = { event_count: 2 };

  const validation = validateTrace(badTrace);

  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /trap:0 busy until 10/);
});

test("validateTrace rejects unsupported event types and gates outside traps", () => {
  const badTrace = structuredClone(trace);
  badTrace.events[0] = {
    ...badTrace.events[0],
    type: "teleport",
  };
  badTrace.events[5] = {
    ...badTrace.events[5],
    source: "segment:0",
    target: "segment:0",
  };

  const validation = validateTrace(badTrace);

  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /unsupported event type teleport/);
  assert.match(validation.errors.join("\n"), /gate event 5 must execute inside one trap/);
});

test("validateTrace rejects DAG nodes without matching gate events", () => {
  const badTrace = structuredClone(trace);
  badTrace.events = badTrace.events.filter((event) => event.metadata?.gate_id !== 1);
  badTrace.metrics = { event_count: badTrace.events.length };

  const validation = validateTrace(badTrace);

  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /dag node 1 has no matching gate event/);
});

test("validateTrace rejects gate events that violate DAG dependency timing", () => {
  const badTrace = structuredClone(trace);
  badTrace.events[5] = {
    ...badTrace.events[5],
    start: 2,
    end: 8,
    source: "trap:0",
    target: "trap:0",
  };

  const validation = validateTrace(badTrace);

  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /dag edge 0->1 violates event order/);
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

test("replay keeps pre-split trap chains for motion-path reconstruction", () => {
  const replay = createReplay(trace, 1);
  const state = replay.stateAt(15);

  assert.deepEqual(state.motionTrapChains.get("trap:0"), [0, 1]);
  assert.deepEqual(state.trapChains.get("trap:0"), [1]);
});

test("replay reserves the merge endpoint during active merges to prevent visual overlap", () => {
  const mergeTrace = {
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
    particles: [
      { id: 0, initial_location: "segment:0" },
      { id: 1, initial_location: "trap:1", initial_slot: 0 },
      { id: 2, initial_location: "trap:1", initial_slot: 1 },
    ],
    events: [
      {
        id: 0,
        type: "merge",
        start: 0,
        end: 10,
        ions: [0],
        source: "segment:0",
        target: "trap:1",
        metadata: { endpoint: "L" },
      },
    ],
    metrics: { event_count: 1 },
  };
  const replay = createReplay(mergeTrace, 1);

  assert.deepEqual(replay.stateAt(5).trapChains.get("trap:1"), ["__merge:0:0", 1, 2]);
  assert.deepEqual(replay.stateAt(10).trapChains.get("trap:1"), [0, 1, 2]);
});

test("replay preserves merge endpoint order in trap chains", () => {
  const endpointTrace = {
    schema_version: "1.0",
    device_type: "ion_trap",
    topology: {
      traps: [
        { id: 0, capacity: 2, slots: [0, 1], orientation: { 0: "R" } },
        { id: 1, capacity: 3, slots: [0, 1, 2], orientation: { 0: "L" } },
      ],
      segments: [{ id: 0, from: "trap:0", to: "trap:1", length: 10 }],
      junctions: [],
    },
    particles: [
      { id: 0, initial_location: "segment:0" },
      { id: 1, initial_location: "trap:1", initial_slot: 0 },
      { id: 2, initial_location: "trap:1", initial_slot: 1 },
    ],
    events: [
      {
        id: 0,
        type: "merge",
        start: 0,
        end: 10,
        ions: [0],
        source: "segment:0",
        target: "trap:1",
        metadata: { endpoint: "L" },
      },
    ],
    metrics: { event_count: 1 },
  };
  const replay = createReplay(endpointTrace, 1);

  assert.deepEqual(replay.stateAt(0).trapChains.get("trap:1"), ["__merge:0:0", 1, 2]);
  assert.deepEqual(replay.stateAt(10).trapChains.get("trap:1"), [0, 1, 2]);

  endpointTrace.events[0].metadata.endpoint = "R";
  endpointTrace.topology.traps[1].orientation = { 0: "R" };
  const rightReplay = createReplay(endpointTrace, 1);

  assert.deepEqual(rightReplay.stateAt(10).trapChains.get("trap:1"), [1, 2, 0]);
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
  metricsTrace.dag = {
    nodes: [
      { id: 0, gate_name: "h", qubits: [0], arity: 1 },
      { id: 2, gate_name: "x", qubits: [1], arity: 1 },
    ],
    edges: [],
  };
  metricsTrace.metrics = { event_count: 3 };

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
