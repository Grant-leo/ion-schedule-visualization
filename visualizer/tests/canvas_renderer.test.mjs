import test from "node:test";
import assert from "node:assert/strict";

import {
  RENDER_SIZES,
  endpointSlotIndex,
  eventProgress,
  interpolatePoint,
  ionLabelSpec,
  ionRenderPoint,
  alignJunctionsToTrapPorts,
  junctionDirections,
  junctionRenderSpec,
  motionPathPoints,
  pointAlongPolyline,
  segmentRoutePoints,
  segmentDrawPoints,
  splitInternalSwapPoints,
  trapConnectedPortSides,
  trapConnectionPoint,
  trapPortPoints,
  trapRenderWidth,
  trapSlotPoint,
} from "../canvas_renderer.js";

test("hardware shuttle channels render wider than moving ions", () => {
  const movingIonDiameter = RENDER_SIZES.activeIonRadius * 2;

  assert.ok(RENDER_SIZES.segmentWidth > movingIonDiameter);
  assert.ok(RENDER_SIZES.activeSegmentWidth > movingIonDiameter);
  assert.ok(RENDER_SIZES.motionPathWidth > movingIonDiameter);
  assert.ok(RENDER_SIZES.junctionRadius >= RENDER_SIZES.segmentWidth / 2);
  assert.ok(RENDER_SIZES.junctionRadius <= RENDER_SIZES.segmentWidth / 2);
  assert.ok(RENDER_SIZES.couplerWidth >= RENDER_SIZES.segmentWidth);
  assert.ok(RENDER_SIZES.couplerWidth <= RENDER_SIZES.segmentWidth);
});

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

test("trapRenderWidth keeps dense linear layouts readable without oversized trap bars", () => {
  assert.equal(trapRenderWidth({ capacity: 2 }), 68);
  assert.equal(trapRenderWidth({ capacity: 5 }), 89);
  assert.equal(trapRenderWidth({ capacity: 8 }), 146);
});

test("trapConnectionPoint connects hardware channels to trap chain ends", () => {
  const trap = { id: 0, capacity: 5, orientation: { 7: "R", 8: "L" } };
  const trapPoint = { x: 100, y: 40, width: 80 };

  assert.deepEqual(trapConnectionPoint(trap, trapPoint, "segment:7"), trapSlotPoint(trapPoint, 4, 5));
  assert.deepEqual(trapConnectionPoint(trap, trapPoint, "segment:8"), trapSlotPoint(trapPoint, 0, 5));
});

test("trapPortPoints exposes both chain-end ports for visual inspection", () => {
  const trapPoint = { x: 100, y: 40, width: 80 };

  assert.deepEqual(trapPortPoints(trapPoint, 5), {
    L: { x: 68, y: 40 },
    R: { x: 132, y: 40 },
  });
});

test("trapConnectedPortSides marks which chain ends are wired to channels", () => {
  assert.deepEqual(trapConnectedPortSides({ orientation: { 2: "L", 7: "R" } }), new Set(["L", "R"]));
  assert.deepEqual(trapConnectedPortSides({ orientation: { 4: "R" } }), new Set(["R"]));
});

test("alignJunctionsToTrapPorts places junctions at connected chain-end columns", () => {
  const trace = {
    topology: {
      traps: [
        { id: 0, capacity: 5, orientation: { 0: "L" } },
        { id: 3, capacity: 5, orientation: { 1: "L" } },
      ],
      segments: [
        { id: 0, from: "trap:0", to: "junction:0" },
        { id: 1, from: "trap:3", to: "junction:0" },
      ],
      junctions: [{ id: 0, degree: 3 }],
    },
  };
  const traps = new Map([
    ["trap:0", { x: 100, y: 40, width: 80 }],
    ["trap:3", { x: 100, y: 200, width: 80 }],
  ]);
  const junctions = new Map([["junction:0", { x: 100, y: 120 }]]);

  alignJunctionsToTrapPorts(trace, traps, junctions);

  assert.equal(junctions.get("junction:0").x, 68);
  assert.equal(junctions.get("junction:0").y, 120);
});

test("alignJunctionsToTrapPorts preserves explicit G9 junction grid points", () => {
  const trace = {
    run: { machine: "G9" },
    topology: {
      traps: [{ id: 0, capacity: 5, orientation: { 0: "L" } }],
      segments: [{ id: 0, from: "trap:0", to: "junction:0" }],
      junctions: [{ id: 0, degree: 3 }],
    },
  };
  const traps = new Map([["trap:0", { x: 100, y: 40, width: 80 }]]);
  const junctions = new Map([["junction:0", { x: 100, y: 120 }]]);

  alignJunctionsToTrapPorts(trace, traps, junctions);

  assert.deepEqual(junctions.get("junction:0"), { x: 100, y: 120 });
});

test("segmentDrawPoints uses orthogonal channel routes from trap ports", () => {
  const layout = {
    traps: new Map([["trap:0", { x: 100, y: 40, width: 80 }]]),
    junctions: new Map([["junction:0", { x: 100, y: 120 }]]),
    segmentEndpoints: new Map([
      [
        "segment:7",
        {
          start: { x: 154, y: 40 },
          end: { x: 100, y: 120 },
          from: "trap:0",
          to: "junction:0",
          route: [
            { x: 154, y: 40 },
            { x: 154, y: 120 },
            { x: 100, y: 120 },
          ],
        },
      ],
    ]),
  };

  assert.deepEqual(segmentDrawPoints(layout, { id: 7, from: "trap:0", to: "junction:0" }), [
    { x: 154, y: 40 },
    { x: 154, y: 120 },
    { x: 100, y: 120 },
  ]);
});

test("segmentRoutePoints enters junctions through topology port directions", () => {
  const route = segmentRoutePoints(
    { x: 132, y: 40 },
    { x: 100, y: 120 },
    "trap:0",
    "junction:0",
    "G3x3",
    {
      traps: new Map([["trap:0", { x: 100, y: 40, width: 80 }]]),
      junctions: new Map([["junction:0", { x: 100, y: 120 }]]),
    },
  );

  assert.deepEqual(route.at(-2), { x: 100, y: 76 });
  assert.deepEqual(route.at(-1), { x: 100, y: 120 });
});

test("segmentRoutePoints avoids redundant trap-side detours while preserving chain endpoints", () => {
  const route = segmentRoutePoints(
    { x: 132, y: 40 },
    { x: 100, y: 120 },
    "trap:0",
    "junction:0",
    "G3x3",
    {
      segmentId: 7,
      traceTraps: [{ id: 0, capacity: 5, orientation: { 7: "R" } }],
      traps: new Map([["trap:0", { x: 100, y: 40, width: 80 }]]),
      junctions: new Map([["junction:0", { x: 100, y: 120 }]]),
    },
  );

  assert.deepEqual(route, [
    { x: 132, y: 40 },
    { x: 100, y: 40 },
    { x: 100, y: 76 },
    { x: 100, y: 120 },
  ]);
});

test("split motion follows the orthogonal channel route after leaving the trap endpoint", () => {
  const layout = {
    traps: new Map([["trap:0", { x: 100, y: 40, width: 80 }]]),
    junctions: new Map([["junction:0", { x: 100, y: 50 }]]),
    segments: new Map([["segment:7", { x: 132, y: 50 }]]),
    segmentEndpoints: new Map([
      [
        "segment:7",
        {
          start: { x: 132, y: 40 },
          end: { x: 100, y: 50 },
          from: "trap:0",
          to: "junction:0",
          route: [
            { x: 132, y: 40 },
            { x: 100, y: 40 },
            { x: 100, y: 50 },
          ],
        },
      ],
    ]),
    traceTrapsFallback: [{ id: 0, capacity: 5, orientation: { 7: "R" } }],
  };

  assert.deepEqual(motionPathPoints(layout, { type: "split", source: "trap:0", target: "segment:7" }), [
    { x: 132, y: 40 },
    { x: 111, y: 40 },
  ]);
});

test("splitInternalSwapPoints reconstructs the chain-internal swap path before shuttling", () => {
  const layout = {
    traps: new Map([["trap:0", { x: 100, y: 40, width: 80 }]]),
    traceTrapsFallback: [{ id: 0, capacity: 5, orientation: { 7: "R" } }],
  };

  assert.deepEqual(
    splitInternalSwapPoints(layout, {
      type: "split",
      source: "trap:0",
      target: "segment:7",
      metadata: { endpoint: "R", swap_count: 1, swap_hops: 2 },
    }),
    [
      { x: 100, y: 40 },
      { x: 132, y: 40 },
    ],
  );
});

test("ionRenderPoint keeps trap-chain ions exactly on their slots", () => {
  const basePoint = { x: 120, y: 80 };

  assert.deepEqual(ionRenderPoint(basePoint, "trap:0", null, 3), basePoint);
  assert.notDeepEqual(ionRenderPoint(basePoint, "segment:0", null, 1), basePoint);
});

test("ion labels are centered inside the rendered ion sphere", () => {
  assert.deepEqual(ionLabelSpec(4, RENDER_SIZES.ionRadius), {
    text: "4",
    xOffset: 0,
    yOffset: 0,
    fontSize: 9,
  });
  assert.deepEqual(ionLabelSpec(21, RENDER_SIZES.ionRadius), {
    text: "21",
    xOffset: 0,
    yOffset: 0,
    fontSize: 7,
  });
});

test("junctionRenderSpec preserves QCCDSim junction degree types", () => {
  assert.deepEqual(junctionRenderSpec({ id: 0, degree: 2, junction_type: "J2" }, [{}, {}]), {
    armCount: 2,
    armLineCap: "butt",
    armLength: RENDER_SIZES.segmentWidth,
    centerRadius: RENDER_SIZES.segmentWidth / 2,
    channelWidth: RENDER_SIZES.segmentWidth,
    hasEnclosure: false,
    highlightWidth: 1.4,
    kind: "straight",
    label: "J2",
    markerArmLength: 8,
    markerRadius: 3.6,
    markerWidth: 2.2,
    outerWidth: RENDER_SIZES.segmentOuterWidth,
  });
  assert.deepEqual(junctionRenderSpec({ id: 1, degree: 3, junction_type: "J3" }, [{}, {}, {}]), {
    armCount: 3,
    armLineCap: "butt",
    armLength: RENDER_SIZES.segmentWidth,
    centerRadius: RENDER_SIZES.segmentWidth / 2,
    channelWidth: RENDER_SIZES.segmentWidth,
    hasEnclosure: false,
    highlightWidth: 1.4,
    kind: "tee",
    label: "J3",
    markerArmLength: 8,
    markerRadius: 3.6,
    markerWidth: 2.2,
    outerWidth: RENDER_SIZES.segmentOuterWidth,
  });
  assert.deepEqual(junctionRenderSpec({ id: 2, degree: 4, junction_type: "J4" }, [{}, {}, {}, {}]), {
    armCount: 4,
    armLineCap: "butt",
    armLength: RENDER_SIZES.segmentWidth,
    centerRadius: RENDER_SIZES.segmentWidth / 2,
    channelWidth: RENDER_SIZES.segmentWidth,
    hasEnclosure: false,
    highlightWidth: 1.4,
    kind: "cross",
    label: "J4",
    markerArmLength: 8,
    markerRadius: 3.6,
    markerWidth: 2.2,
    outerWidth: RENDER_SIZES.segmentOuterWidth,
  });
});

test("junctionDirections follows the adjacent routed channel segment", () => {
  const trace = {
    topology: {
      segments: [
        { id: 0, from: "junction:0", to: "trap:0" },
        { id: 1, from: "junction:0", to: "junction:1" },
      ],
    },
  };
  const layout = {
    segmentEndpoints: new Map([
      [
        "segment:0",
        {
          start: { x: 100, y: 100 },
          end: { x: 180, y: 20 },
          route: [
            { x: 100, y: 100 },
            { x: 180, y: 100 },
            { x: 180, y: 20 },
          ],
        },
      ],
      [
        "segment:1",
        {
          start: { x: 100, y: 100 },
          end: { x: 100, y: 220 },
          route: [
            { x: 100, y: 100 },
            { x: 100, y: 220 },
          ],
        },
      ],
    ]),
  };

  assert.deepEqual(junctionDirections(trace, layout, "junction:0", { x: 100, y: 100 }), [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
  ]);
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
