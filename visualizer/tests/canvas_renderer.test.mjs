import test from "node:test";
import assert from "node:assert/strict";

import { endpointSlotIndex, eventProgress, interpolatePoint, trapSlotPoint } from "../canvas_renderer.js";

test("eventProgress clamps time inside event duration", () => {
  const event = { start: 10, end: 20 };

  assert.equal(eventProgress(event, 5), 0);
  assert.equal(eventProgress(event, 15), 0.5);
  assert.equal(eventProgress(event, 30), 1);
});

test("interpolatePoint returns the in-flight particle position", () => {
  const start = { x: 10, y: 20 };
  const end = { x: 30, y: 60 };

  assert.deepEqual(interpolatePoint(start, end, 0.25), { x: 15, y: 30 });
});

test("endpointSlotIndex follows QCCDSim trap segment orientation", () => {
  const trap = { id: 0, capacity: 5, orientation: { 7: "R", 8: "L" } };

  assert.equal(endpointSlotIndex(trap, "segment:7"), 4);
  assert.equal(endpointSlotIndex(trap, "segment:8"), 0);
});

test("trapSlotPoint lays out ions along a horizontal trap chain", () => {
  const trapPoint = { x: 100, y: 40, width: 80 };

  assert.deepEqual(trapSlotPoint(trapPoint, 0, 5), { x: 68, y: 40 });
  assert.deepEqual(trapSlotPoint(trapPoint, 4, 5), { x: 132, y: 40 });
});
