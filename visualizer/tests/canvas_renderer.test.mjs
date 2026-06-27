import test from "node:test";
import assert from "node:assert/strict";

import {
  endpointSlotIndex,
  eventProgress,
  interpolatePoint,
  ionRenderPoint,
  motionPathPoints,
  pointAlongPolyline,
  trapConnectionPoint,
  trapSlotPoint,
} from "../canvas_renderer.js";

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

test("trapConnectionPoint connects hardware segments to chain endpoints", () => {
  const trap = { id: 0, capacity: 5, orientation: { 7: "R", 8: "L" } };
  const trapPoint = { x: 100, y: 40, width: 80 };

  assert.deepEqual(trapConnectionPoint(trap, trapPoint, "segment:7"), { x: 132, y: 40 });
  assert.deepEqual(trapConnectionPoint(trap, trapPoint, "segment:8"), { x: 68, y: 40 });
});

test("ionRenderPoint keeps trap-chain ions exactly on their slots", () => {
  const basePoint = { x: 120, y: 80 };

  assert.deepEqual(ionRenderPoint(basePoint, "trap:0", null, 3), basePoint);
  assert.notDeepEqual(ionRenderPoint(basePoint, "segment:0", null, 1), basePoint);
});

test("motionPathPoints routes segment moves through the shared junction", () => {
  const layout = {
    segments: new Map([
      ["segment:0", { x: 50, y: 0 }],
      ["segment:1", { x: 100, y: 50 }],
    ]),
    segmentEndpoints: new Map([
      ["segment:0", { start: { x: 0, y: 0 }, end: { x: 100, y: 0 } }],
      ["segment:1", { start: { x: 100, y: 0 }, end: { x: 100, y: 100 } }],
    ]),
    traps: new Map(),
    junctions: new Map(),
  };

  assert.deepEqual(motionPathPoints(layout, { type: "move", source: "segment:0", target: "segment:1" }), [
    { x: 50, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 50 },
  ]);
});

test("pointAlongPolyline interpolates by physical path length", () => {
  const path = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ];

  assert.deepEqual(pointAlongPolyline(path, 0.25), { x: 50, y: 0 });
  assert.deepEqual(pointAlongPolyline(path, 0.75), { x: 100, y: 50 });
});
