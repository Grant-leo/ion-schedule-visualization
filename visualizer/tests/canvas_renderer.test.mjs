import test from "node:test";
import assert from "node:assert/strict";

import { eventProgress, interpolatePoint } from "../canvas_renderer.js";

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
