import test from "node:test";
import assert from "node:assert/strict";

import {
  RENDER_SIZES,
  cssColor,
  endpointSlotIndex,
  eventProgress,
  gateLaserTargets,
  activeJunctionActivity,
  interpolatePoint,
  ionLabelSpec,
  ionRenderPoint,
  alignJunctionsToTrapPorts,
  alignTrapPortsToFixedJunctions,
  junctionDirections,
  junctionRenderSpec,
  motionPathPoints,
  pointAlongPolyline,
  resetCssColorCache,
  resizeCanvas,
  segmentRoutePoints,
  segmentDrawPoints,
  splitInternalSwapPoints,
  trapConnectedPortSides,
  trapConnectionPoint,
  trapPortPoints,
  trapRenderWidth,
  trapSlotPoint,
} from "../canvas_renderer.js";

test("resizeCanvas keeps layout dimensions in CSS pixels on high-DPI displays", () => {
  const previousDpr = globalThis.devicePixelRatio;
  globalThis.devicePixelRatio = 2;
  const canvas = {
    width: 0,
    height: 0,
    getBoundingClientRect: () => ({ width: 640, height: 360 }),
  };

  const viewport = resizeCanvas(canvas);
  const stable = resizeCanvas(canvas);

  assert.deepEqual(viewport, { width: 640, height: 360, dpr: 2, resized: true });
  assert.deepEqual(stable, { width: 640, height: 360, dpr: 2, resized: false });
  assert.equal(canvas.width, 1280);
  assert.equal(canvas.height, 720);
  globalThis.devicePixelRatio = previousDpr;
});

test("cssColor caches computed CSS variables during a render pass", () => {
  const previousDocument = globalThis.document;
  const previousGetComputedStyle = globalThis.getComputedStyle;
  let reads = 0;
  globalThis.document = { documentElement: {} };
  globalThis.getComputedStyle = () => ({
    getPropertyValue: (name) => {
      reads += 1;
      return name === "--color-move" ? " #64d2ff " : "";
    },
  });
  resetCssColorCache();

  assert.equal(cssColor("--color-move"), "#64d2ff");
  assert.equal(cssColor("--color-move"), "#64d2ff");
  assert.equal(reads, 1);

  resetCssColorCache();
  globalThis.document = previousDocument;
  globalThis.getComputedStyle = previousGetComputedStyle;
});

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
  assert.ok(trapRenderWidth({ capacity: 5 }) >= 122);
  assert.ok(trapRenderWidth({ capacity: 8 }) >= 220);
});

test("trapRenderWidth keeps high-capacity chain slots wider than active ion spheres", () => {
  const trapPoint = { x: 0, y: 0, width: trapRenderWidth({ capacity: 8 }) };
  const left = trapSlotPoint(trapPoint, 0, 8);
  const next = trapSlotPoint(trapPoint, 1, 8);

  assert.ok(next.x - left.x > RENDER_SIZES.activeIonRadius * 2 + 4);
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

test("alignTrapPortsToFixedJunctions shifts G9 edge traps so channels enter chain ends directly", () => {
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

  alignTrapPortsToFixedJunctions(trace, traps, junctions);

  const trap = trace.topology.traps[0];
  const trapPoint = traps.get("trap:0");
  const port = trapConnectionPoint(trap, trapPoint, "segment:0");
  assert.deepEqual(port, { x: 100, y: 40 });
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

test("segmentRoutePoints leaves trap endpoints before aligning to junctions", () => {
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
    { x: 132, y: 76 },
    { x: 100, y: 76 },
    { x: 100, y: 120 },
  ]);
});

test("segmentRoutePoints keeps aligned G9 trap-to-junction channels straight", () => {
  const route = segmentRoutePoints(
    { x: 300, y: 120 },
    { x: 300, y: 240 },
    "trap:0",
    "junction:0",
    "G9",
    {
      segmentId: 0,
      traceTraps: [{ id: 0, capacity: 5, orientation: { 0: "L" } }],
      traps: new Map([["trap:0", { x: 332, y: 120, width: 80 }]]),
      junctions: new Map([["junction:0", { x: 300, y: 240 }]]),
    },
  );

  assert.deepEqual(route, [
    { x: 300, y: 120 },
    { x: 300, y: 240 },
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

test("splitInternalSwapPoints starts from the ion's live trap-chain slot", () => {
  const layout = {
    traps: new Map([["trap:0", { x: 100, y: 40, width: 80 }]]),
    traceTrapsFallback: [{ id: 0, capacity: 5, orientation: { 7: "R" } }],
  };
  const state = { trapChains: new Map([["trap:0", [8, 9, 7, 2, 3]]]) };

  assert.deepEqual(
    splitInternalSwapPoints(
      layout,
      {
        type: "split",
        ions: [7],
        source: "trap:0",
        target: "segment:7",
        metadata: { endpoint: "R", swap_count: 1, swap_hops: 1 },
      },
      state,
    ),
    [
      trapSlotPoint({ x: 100, y: 40, width: 80 }, 2, 5),
      trapSlotPoint({ x: 100, y: 40, width: 80 }, 4, 5),
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

test("gate laser targets the actual ion slots from the live trap chain", () => {
  const layout = {
    traps: new Map([["trap:2", { x: 100, y: 60, width: 80 }]]),
    junctions: new Map(),
    segments: new Map(),
    traceTrapsFallback: [{ id: 2, capacity: 4, orientation: {} }],
  };
  const state = {
    trapChains: new Map([["trap:2", [7, 3, 5, 9]]]),
    locations: new Map([
      [3, "trap:2"],
      [5, "trap:2"],
    ]),
  };

  const targets = gateLaserTargets(layout, state, { target: "trap:2", ions: [3, 5] });

  assert.deepEqual(targets, [
    { ion: 3, point: trapSlotPoint({ x: 100, y: 60, width: 80 }, 1, 4) },
    { ion: 5, point: trapSlotPoint({ x: 100, y: 60, width: 80 }, 2, 4) },
  ]);
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

test("activeJunctionActivity highlights the shared junction while an ion is crossing it", () => {
  const trace = {
    topology: {
      junctions: [{ id: 0, degree: 3 }],
      segments: [
        { id: 0, from: "trap:0", to: "junction:0" },
        { id: 1, from: "junction:0", to: "trap:1" },
      ],
    },
  };
  const layout = {
    traps: new Map(),
    junctions: new Map([["junction:0", { x: 100, y: 0 }]]),
    segments: new Map([
      ["segment:0", { x: 50, y: 0 }],
      ["segment:1", { x: 150, y: 0 }],
    ]),
    segmentEndpoints: new Map([
      ["segment:0", { from: "trap:0", to: "junction:0", start: { x: 0, y: 0 }, end: { x: 100, y: 0 } }],
      ["segment:1", { from: "junction:0", to: "trap:1", start: { x: 100, y: 0 }, end: { x: 200, y: 0 } }],
    ]),
  };

  const activity = activeJunctionActivity(trace, layout, {
    time: 5,
    activeEvents: [{ id: 1, type: "move", start: 0, end: 10, ions: [0], source: "segment:0", target: "segment:1" }],
  });

  assert.ok(activity.get("junction:0") > 0.9);
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
