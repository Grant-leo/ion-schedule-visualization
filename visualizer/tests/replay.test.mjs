import test from "node:test";
import assert from "node:assert/strict";

import { createReplay, validateTrace } from "../replay.js";

const trace = {
  schema_version: "1.0",
  device_type: "ion_trap",
  topology: {
    traps: [{ id: 0 }, { id: 1 }],
    segments: [{ id: 0, from: "trap:0", to: "trap:1", length: 10 }],
    junctions: [],
  },
  particles: [{ id: 0, initial_location: "trap:0" }],
  events: [
    {
      id: 0,
      type: "split",
      start: 0,
      end: 10,
      ions: [0],
      source: "trap:0",
      target: "segment:0",
      metadata: {},
    },
    {
      id: 1,
      type: "merge",
      start: 10,
      end: 20,
      ions: [0],
      source: "segment:0",
      target: "trap:1",
      metadata: {},
    },
  ],
  metrics: { event_count: 2 },
};

test("validateTrace accepts a valid motion trace", () => {
  assert.equal(validateTrace(trace).valid, true);
});

test("replay returns correct locations before and after motion", () => {
  const replay = createReplay(trace, 1);

  assert.equal(replay.stateAt(0).locations.get(0), "trap:0");
  assert.equal(replay.stateAt(10).locations.get(0), "segment:0");
  assert.equal(replay.stateAt(20).locations.get(0), "trap:1");
});

test("replay reports active events for in-flight animation", () => {
  const replay = createReplay(trace, 1);
  const active = replay.stateAt(5).activeEvents;

  assert.equal(active.length, 1);
  assert.equal(active[0].type, "split");
});

test("validateTrace rejects motion from a stale source", () => {
  const badTrace = structuredClone(trace);
  badTrace.events[1] = {
    ...badTrace.events[1],
    source: "trap:0",
  };

  const validation = validateTrace(badTrace);

  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /not at trap:0/);
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
  badTrace.events[1] = {
    ...badTrace.events[1],
    start: 5,
    end: 20,
  };

  const validation = validateTrace(badTrace);

  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /busy until 10/);
});

test("nextEventTime advances to the next event start", () => {
  const replay = createReplay(trace, 1);

  assert.equal(replay.nextEventTime(0), 10);
  assert.equal(replay.nextEventTime(10), 20);
});
