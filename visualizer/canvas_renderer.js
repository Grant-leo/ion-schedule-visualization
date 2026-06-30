const FALLBACK_COLORS = {
  "--color-bg": "#101216",
  "--color-canvas": "#050607",
  "--color-panel": "#181c22",
  "--color-border": "#2f3742",
  "--color-text": "#eef2f7",
  "--color-muted": "#a8b1bd",
  "--color-trap": "#4677c8",
  "--color-segment": "#657080",
  "--color-junction": "#d5a84f",
  "--color-gate": "#98c379",
  "--color-move": "#61afef",
  "--color-warning": "#e6ba60",
};

const MOTION_TYPES = new Set(["split", "move", "merge"]);
const cssColorCache = new Map();
const SPLIT_SWAP_PHASE_FRACTION = 0.34;

export const RENDER_SIZES = Object.freeze({
  ionRadius: 8,
  activeIonRadius: 9,
  segmentWidth: 20,
  activeSegmentWidth: 26,
  segmentOuterWidth: 28,
  activeSegmentOuterWidth: 36,
  motionPathWidth: 28,
  trapHeight: 28,
  junctionRadius: 10,
});

export function createRenderer(canvas) {
  const context = canvas.getContext("2d", { alpha: false });
  let trace = null;
  let layout = null;
  let viewport = null;

  return {
    setTrace(nextTrace) {
      trace = nextTrace;
      viewport = resizeCanvas(canvas);
      layout = computeLayout(viewport, trace);
    },
    draw(state) {
      if (!trace || !layout) return;
      viewport = resizeCanvas(canvas);
      if (viewport.resized) layout = computeLayout(viewport, trace);

      context.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
      context.clearRect(0, 0, viewport.width, viewport.height);
      drawBackground(context, viewport);
      drawSegments(context, trace, layout, state);
      drawTraps(context, trace, layout);
      drawJunctions(context, trace, layout, state);
      drawActiveEvents(context, layout, state);
      drawActiveJunctionOverlays(context, trace, layout, state);
      drawIons(context, trace, layout, state);
    },
  };
}

export function resizeCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, Number(globalThis.devicePixelRatio) || 1);
  const width = Math.max(320, Math.floor(rect.width || 0));
  const height = Math.max(240, Math.floor(rect.height || 0));
  const pixelWidth = Math.floor(width * dpr);
  const pixelHeight = Math.floor(height * dpr);
  const resized = canvas.width !== pixelWidth || canvas.height !== pixelHeight;
  if (resized) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  return { width, height, dpr, resized };
}

export function eventProgress(event, time) {
  const duration = Math.max(1, event.end - event.start);
  return clamp((time - event.start) / duration, 0, 1);
}

export function interpolatePoint(start, end, progress) {
  return {
    x: start.x + (end.x - start.x) * progress,
    y: start.y + (end.y - start.y) * progress,
  };
}

export function endpointSlotIndex(trap, segmentLocation) {
  const segmentId = segmentLocation.split(":")[1];
  const endpoint = trap.orientation?.[segmentId];
  if (endpoint === "R") return Math.max(0, trap.capacity - 1);
  return 0;
}

function trapSlotOffset(trapPoint, slotIndex, capacity) {
  const usableWidth = trapPoint.width * 0.8;
  const left = -usableWidth / 2;
  const step = capacity <= 1 ? 0 : usableWidth / (capacity - 1);
  return left + step * slotIndex;
}

function trapAxisUnit(trapPoint) {
  const angle = Number.isFinite(trapPoint?.angle) ? trapPoint.angle : 0;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

export function trapSlotPoint(trapPoint, slotIndex, capacity) {
  const offset = trapSlotOffset(trapPoint, slotIndex, capacity);
  const axis = trapAxisUnit(trapPoint);
  return {
    x: trapPoint.x + axis.x * offset,
    y: trapPoint.y + axis.y * offset,
  };
}

export function trapRenderWidth(trap) {
  const highCapacityAllowance = Math.max(0, trap.capacity - 6) * 6;
  const readableChainWidth =
    trap.capacity <= 1
      ? 68
      : ((trap.capacity - 1) * (RENDER_SIZES.activeIonRadius * 2 + 5)) / 0.8 + 24;
  return Math.max(68, Math.min(240, Math.max(15 * trap.capacity + 14 + highCapacityAllowance, readableChainWidth)));
}

export function trapConnectionPoint(trap, trapPoint, segmentLocation) {
  return trapSlotPoint(trapPoint, endpointSlotIndex(trap, segmentLocation), trap.capacity);
}

export function trapPortPoints(trapPoint, capacity = 5) {
  return {
    L: trapSlotPoint(trapPoint, 0, capacity),
    R: trapSlotPoint(trapPoint, Math.max(0, capacity - 1), capacity),
  };
}

export function trapConnectedPortSides(trap) {
  return new Set(
    Object.values(trap.orientation || {}).filter((side) => side === "L" || side === "R"),
  );
}

export function segmentDrawPoints(layout, segment) {
  const endpoints = layout.segmentEndpoints?.get(`segment:${segment.id}`);
  if (endpoints?.route) return endpoints.route;
  if (endpoints?.start && endpoints?.end) return [endpoints.start, endpoints.end];
  return [resolveLocationPoint(layout, segment.from), resolveLocationPoint(layout, segment.to)].filter(Boolean);
}

export function pointAlongPolyline(points, progress) {
  if (!points || points.length === 0) return null;
  if (points.length === 1) return points[0];

  const total = polylineLength(points);
  if (total === 0) return points[points.length - 1];

  let target = total * clamp(progress, 0, 1);
  for (let index = 1; index < points.length; index += 1) {
    const segmentLength = distance(points[index - 1], points[index]);
    if (target <= segmentLength) {
      const localProgress = segmentLength === 0 ? 1 : target / segmentLength;
      return interpolatePoint(points[index - 1], points[index], localProgress);
    }
    target -= segmentLength;
  }
  return points[points.length - 1];
}

export function polylineLength(points) {
  if (!points || points.length <= 1) return 0;
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += distance(points[index - 1], points[index]);
  }
  return total;
}

export function motionTravelProgress(event, time, path, speedPxPerCycle = 0) {
  return eventProgress(event, time);
}

function motionTravelDistance(event, time, speedPxPerCycle = 0) {
  const speed = Number(speedPxPerCycle);
  if (!Number.isFinite(speed) || speed <= 0) return null;
  return Math.max(0, Number(time) - Number(event.start || 0)) * speed;
}

function traceMotionSpeed(layout, trace) {
  let speed = 0;
  for (const event of trace.events || []) {
    if (!MOTION_TYPES.has(event.type)) continue;
    const path = motionPathPoints(layout, event, null);
    const length = polylineLength(path);
    const duration = Math.max(1, Number(event.end || 0) - Number(event.start || 0));
    if (length > 0) speed = Math.max(speed, length / duration);
  }
  return speed;
}

export function motionPathPoints(layout, event, state = null) {
  const start = eventEndpointPoint(layout, event, event.source) || resolveLocationPoint(layout, event.source);
  const end = eventEndpointPoint(layout, event, event.target) || resolveLocationPoint(layout, event.target);
  if (!start || !end) return [start || end].filter(Boolean);

  if (event.source?.startsWith("segment:") && event.target?.startsWith("segment:")) {
    const shared = sharedSegmentEndpoint(layout, event.source, event.target);
    if (shared) {
      return compactPath([
        ...segmentCenterToEndpointPath(layout, event.source, shared),
        ...segmentEndpointToCenterPath(layout, event.target, shared).slice(1),
      ]);
    }
    return compactPath([start, end]);
  }

  if (event.source?.startsWith("trap:") && event.target?.startsWith("segment:")) {
    const swapPath = splitInternalSwapPoints(layout, event, state);
    const exitPath = segmentEndpointToCenterPath(layout, event.target, event.source);
    return compactPath([...(swapPath.length ? swapPath : [start]), ...exitPath]);
  }

  if (event.source?.startsWith("segment:") && event.target?.startsWith("trap:")) {
    return compactPath([...segmentCenterToEndpointPath(layout, event.source, event.target), end]);
  }

  return compactPath([start, end]);
}

export function splitInternalSwapPoints(layout, event, state = null) {
  const swapHops = Number(event.metadata?.swap_hops || 0);
  const swapCount = Number(event.metadata?.swap_count || 0);
  if (event.type !== "split" || swapCount <= 0 || swapHops <= 0 || !event.source?.startsWith("trap:")) {
    return [];
  }
  const trap = (layout.traceTrapsFallback || []).find((item) => `trap:${item.id}` === event.source);
  const trapPoint = layout.traps.get(event.source);
  if (!trap || !trapPoint) return [];
  const endpointSlot = endpointSlotIndex(trap, event.target);
  const liveSlot = liveTrapChainSlot(event, state);
  const startSlot = liveSlot ?? (
    event.metadata?.endpoint === "R"
      ? Math.max(0, endpointSlot - swapHops)
      : Math.min(trap.capacity - 1, endpointSlot + swapHops)
  );
  if (startSlot === endpointSlot) return [];
  return slotWalkPoints(trapPoint, trap.capacity, startSlot, endpointSlot);
}

function liveTrapChainSlot(event, state) {
  const chain = state?.motionTrapChains?.get(event.source) || state?.trapChains?.get(event.source);
  if (!chain || !(event.ions || []).length) return null;
  const index = chain.indexOf(event.ions[0]);
  return index >= 0 ? index : null;
}

export function activeSplitSwapPoint(layout, event, state = {}, ionId) {
  const info = splitSwapInfo(layout, event, state);
  if (!info) return null;
  const ion = Number(ionId);
  if (ion !== info.firstIon && ion !== info.secondIon) return null;
  const firstPoint = trapSlotPoint(info.trapPoint, info.firstSlot, info.trap.capacity);
  const secondPoint = trapSlotPoint(info.trapPoint, info.secondSlot, info.trap.capacity);
  const swapProgress = splitSwapProgress(layout, event, state, firstPoint, secondPoint);

  if (ion === info.firstIon) {
    if (swapProgress >= 1) return null;
    return swapLanePoint(firstPoint, secondPoint, swapProgress, -1);
  }
  if (swapProgress >= 1) return firstPoint;
  return swapLanePoint(secondPoint, firstPoint, swapProgress, -1);
}

function splitSwapProgress(layout, event, state, firstPoint, secondPoint) {
  const swapLength = distance(firstPoint, secondPoint);
  if (swapLength <= 0) return 1;
  const reference = continuousMotionGroup(layout, event, state);
  const path = reference?.path || eventMotionPathPoints(layout, event, state);
  const pathLength = polylineLength(path);
  if (pathLength > 0) {
    const traveled = pathLength * eventProgress(
      { start: reference?.start ?? event.start, end: reference?.end ?? event.end },
      state.time ?? event.start,
    );
    return clamp(traveled / swapLength, 0, 1);
  }
  const traveled = motionTravelDistance(event, state.time ?? event.start, layout.motionSpeedPxPerCycle);
  return traveled === null
    ? clamp(eventProgress(event, state.time ?? event.start) / SPLIT_SWAP_PHASE_FRACTION, 0, 1)
    : clamp(traveled / swapLength, 0, 1);
}

function swapLanePoint(start, end, progress, lane) {
  const clampedProgress = clamp(progress, 0, 1);
  const base = interpolatePoint(start, end, clampedProgress);
  const length = distance(start, end);
  if (length <= 0) return base;
  const offset = Math.sin(Math.PI * clampedProgress) * Math.max(RENDER_SIZES.activeIonRadius * 1.45, 14) * lane;
  return {
    x: base.x - ((end.y - start.y) / length) * offset,
    y: base.y + ((end.x - start.x) / length) * offset,
  };
}

function splitSwapInfo(layout, event, state = {}) {
  const swapIons = (event.metadata?.swap_ions || []).map((ion) => Number(ion));
  if (
    event.type !== "split" ||
    Number(event.metadata?.swap_count || 0) <= 0 ||
    swapIons.length !== 2 ||
    !event.source?.startsWith("trap:")
  ) {
    return null;
  }
  const trap = (layout.traceTrapsFallback || []).find((item) => `trap:${item.id}` === event.source);
  const trapPoint = layout.traps.get(event.source);
  const chain = state?.motionTrapChains?.get(event.source) || state?.trapChains?.get(event.source);
  if (!trap || !trapPoint || !chain) return null;
  const [firstIon, secondIon] = swapIons;
  const firstSlot = chain.indexOf(firstIon);
  const secondSlot = chain.indexOf(secondIon);
  if (firstSlot < 0 || secondSlot < 0 || firstSlot === secondSlot) return null;
  return { trap, trapPoint, firstIon, secondIon, firstSlot, secondSlot };
}

function slotWalkPoints(trapPoint, capacity, startSlot, endSlot) {
  if (startSlot === endSlot) return [trapSlotPoint(trapPoint, clamp(startSlot, 0, capacity - 1), capacity)];
  const direction = endSlot > startSlot ? 1 : -1;
  const points = [];
  for (let slot = startSlot; ; slot += direction) {
    points.push(trapSlotPoint(trapPoint, clamp(slot, 0, capacity - 1), capacity));
    if (slot === endSlot) break;
  }
  return points;
}

export function ionRenderPoint(basePoint, location, activeMotion, offsetIndex) {
  if (!basePoint) return null;
  if (!activeMotion && location?.startsWith("trap:")) return basePoint;
  return offsetPoint(basePoint, offsetIndex);
}

export function ionLabelSpec(id, radius) {
  const text = String(id);
  return {
    text,
    xOffset: 0,
    yOffset: 0,
    fontSize: text.length >= 2 ? Math.max(7, Math.floor(radius * 0.88)) : Math.max(9, Math.floor(radius * 1.08)),
  };
}

export function junctionRenderSpec(junction = {}, directions = []) {
  const armCount = Number(junction.degree ?? directions.length ?? 0);
  let kind = "multiport";
  if (armCount === 2) kind = "straight";
  if (armCount === 3) kind = "tee";
  if (armCount === 4) kind = "cross";
  return {
    armCount,
    armLineCap: "butt",
    armLength: RENDER_SIZES.segmentWidth,
    centerRadius: RENDER_SIZES.segmentWidth / 2,
    channelWidth: RENDER_SIZES.segmentWidth,
    hasEnclosure: false,
    highlightWidth: 1.4,
    kind,
    label: junction.junction_type || `J${armCount}`,
    markerArmLength: 8,
    markerRadius: 3.6,
    markerWidth: 2.2,
    outerWidth: RENDER_SIZES.segmentOuterWidth,
  };
}

function computeLayout(viewport, trace) {
  const width = viewport.width;
  const height = viewport.height;
  const marginX = Math.max(92, width * 0.1);
  const marginY = Math.max(84, height * 0.12);
  const traps = new Map();
  const junctions = new Map();
  const segments = new Map();
  const segmentEndpoints = new Map();
  const rawLayout = normalizeTraceLayoutForRendering(trace);
  const rawPoints = Object.values(rawLayout);
  const minX = Math.min(...rawPoints.map((point) => point.x), 0);
  const maxX = Math.max(...rawPoints.map((point) => point.x), 1);
  const minY = Math.min(...rawPoints.map((point) => point.y), 0);
  const maxY = Math.max(...rawPoints.map((point) => point.y), 1);

  const trapCount = Math.max(1, trace.topology.traps.length);
  for (const [index, trap] of trace.topology.traps.entries()) {
    const location = `trap:${trap.id}`;
    const point = rawLayout[location];
    const fallbackX =
      trapCount === 1
        ? width / 2
        : marginX + (index * (width - marginX * 2)) / Math.max(1, trapCount - 1);
    const scaled = point ? scaleLayoutPoint(point, minX, maxX, minY, maxY, marginX, marginY, width, height) : null;
    const x = scaled ? scaled.x : fallbackX;
    const y = scaled ? scaled.y : height * 0.58;
    traps.set(location, { x, y, width: trapRenderWidth(trap) });
  }

  const junctionCount = Math.max(1, trace.topology.junctions.length);
  for (const [index, junction] of trace.topology.junctions.entries()) {
    const location = `junction:${junction.id}`;
    const point = rawLayout[location];
    const fallbackX =
      junctionCount === 1
        ? width / 2
        : marginX + (index * (width - marginX * 2)) / Math.max(1, junctionCount - 1);
    const scaled = point ? scaleLayoutPoint(point, minX, maxX, minY, maxY, marginX, marginY, width, height) : null;
    const x = scaled ? scaled.x : fallbackX;
    const y = scaled ? scaled.y : height * 0.34;
    junctions.set(location, { x, y });
  }

  alignTrapPortsToFixedJunctions(trace, traps, junctions);
  alignJunctionsToTrapPorts(trace, traps, junctions);
  assignTrapAngles(trace, traps, junctions);

  for (const segment of trace.topology.segments) {
    const start = resolveSegmentNodePoint(traps, junctions, trace.topology.traps, segment.from, segment.id);
    const end = resolveSegmentNodePoint(traps, junctions, trace.topology.traps, segment.to, segment.id);
    if (!start || !end) continue;
    const key = `segment:${segment.id}`;
    const route = segmentRoutePoints(start, end, segment.from, segment.to, trace.run?.machine, {
      traps,
      junctions,
      traceTraps: trace.topology.traps,
      segmentId: segment.id,
    });
    segments.set(key, pointAlongPolyline(route, 0.5));
    segmentEndpoints.set(key, { start, end, from: segment.from, to: segment.to, route });
  }

  const layout = {
    traps,
    junctions,
    segments,
    segmentEndpoints,
    traceEventsFallback: trace.events || [],
    traceTrapsFallback: trace.topology.traps,
  };
  layout.motionSpeedPxPerCycle = traceMotionSpeed(layout, trace);
  return layout;
}

export function normalizeTraceLayoutForRendering(trace) {
  const rawLayout = trace?.topology?.layout || {};
  if (trace?.run?.machine === "H6") {
    return repairH6JunctionLayout(trace, rawLayout);
  }
  if (trace?.run?.machine === "L6") {
    return repairLinearJunctionLayout(trace, rawLayout);
  }
  if (trace?.run?.machine !== "G9" || !g9TraceLayoutNeedsExteriorRepair(trace, rawLayout)) {
    return rawLayout;
  }
  return repairG9ExteriorTrapLayout(trace, rawLayout);
}

function repairLinearJunctionLayout(trace, rawLayout) {
  const repaired = {};
  for (const [location, point] of Object.entries(rawLayout)) {
    repaired[location] = { ...point };
  }

  for (const junction of trace?.topology?.junctions || []) {
    const junctionLocation = `junction:${junction.id}`;
    const connectedTrapYs = [];
    for (const segment of trace?.topology?.segments || []) {
      const trapLocation = segment.from?.startsWith("trap:")
        ? segment.from
        : segment.to?.startsWith("trap:")
          ? segment.to
          : null;
      if (!trapLocation || (segment.from !== junctionLocation && segment.to !== junctionLocation)) continue;
      const trapPoint = repaired[trapLocation];
      if (trapPoint) connectedTrapYs.push(trapPoint.y);
    }
    if (!connectedTrapYs.length || !repaired[junctionLocation]) continue;
    repaired[junctionLocation] = {
      ...repaired[junctionLocation],
      y: average(connectedTrapYs),
    };
  }

  return repaired;
}

function repairH6JunctionLayout(trace, rawLayout) {
  const repaired = {};
  for (const [location, point] of Object.entries(rawLayout)) {
    repaired[location] = { ...point };
  }

  const trapPoints = [];
  for (const trap of trace?.topology?.traps || []) {
    const point = repaired[`trap:${trap.id}`];
    if (point) trapPoints.push(point);
  }
  if (!trapPoints.length) return repaired;

  const center = {
    x: average(trapPoints.map((point) => point.x)),
    y: average(trapPoints.map((point) => point.y)),
  };
  const trapRadius = average(trapPoints.map((point) => distance(point, center))) || 1;
  const minimumRingRadius = trapRadius * 0.9;

  for (const junction of trace?.topology?.junctions || []) {
    const junctionLocation = `junction:${junction.id}`;
    const current = repaired[junctionLocation];
    if (!current) continue;
    const connectedTrapPoints = connectedTrapLocations(trace, junctionLocation)
      .map((location) => repaired[location])
      .filter(Boolean);
    const direction = h6JunctionDirection(center, connectedTrapPoints, current);
    if (!direction || distance(current, center) >= minimumRingRadius) continue;
    repaired[junctionLocation] = {
      ...current,
      x: center.x + direction.x * trapRadius,
      y: center.y + direction.y * trapRadius,
    };
  }

  return repaired;
}

function connectedTrapLocations(trace, junctionLocation) {
  const locations = [];
  for (const segment of trace?.topology?.segments || []) {
    if (segment.from === junctionLocation && segment.to?.startsWith("trap:")) locations.push(segment.to);
    if (segment.to === junctionLocation && segment.from?.startsWith("trap:")) locations.push(segment.from);
  }
  return locations;
}

function h6JunctionDirection(center, connectedTrapPoints, fallbackPoint) {
  const vectors = connectedTrapPoints.map((point) => unitVector(center, point)).filter(Boolean);
  const summed = vectors.reduce((accumulator, vector) => ({
    x: accumulator.x + vector.x,
    y: accumulator.y + vector.y,
  }), { x: 0, y: 0 });
  return normalizeVector(summed) || unitVector(center, fallbackPoint);
}

function unitVector(from, to) {
  if (!from || !to) return null;
  return normalizeVector({ x: to.x - from.x, y: to.y - from.y });
}

function normalizeVector(vector) {
  const length = Math.hypot(vector.x, vector.y);
  if (length < 0.001) return null;
  return { x: vector.x / length, y: vector.y / length };
}

function g9TraceLayoutNeedsExteriorRepair(trace, rawLayout) {
  for (const segment of trace?.topology?.segments || []) {
    const trapLocation = segment.from?.startsWith("trap:")
      ? segment.from
      : segment.to?.startsWith("trap:")
        ? segment.to
        : null;
    const junctionLocation = segment.from?.startsWith("junction:")
      ? segment.from
      : segment.to?.startsWith("junction:")
        ? segment.to
        : null;
    if (!trapLocation || !junctionLocation) continue;
    const trapPoint = rawLayout[trapLocation];
    const junctionPoint = rawLayout[junctionLocation];
    if (sameRawLayoutPoint(trapPoint, junctionPoint)) return true;
  }
  return false;
}

function repairG9ExteriorTrapLayout(trace, rawLayout) {
  const repaired = {};
  for (const [location, point] of Object.entries(rawLayout)) {
    repaired[location] = { ...point };
  }

  const junctionPoints = new Map();
  for (const junction of trace.topology?.junctions || []) {
    const location = `junction:${junction.id}`;
    const point = repaired[location] || { x: junction.id % 3, y: Math.floor(junction.id / 3) };
    repaired[location] = point;
    junctionPoints.set(location, point);
  }

  const trapsByJunction = new Map();
  for (const trap of [...(trace.topology?.traps || [])].sort((left, right) => left.id - right.id)) {
    const trapLocation = `trap:${trap.id}`;
    const junctionLocation = firstConnectedJunctionLocation(trace, trapLocation);
    if (!junctionLocation) continue;
    const traps = trapsByJunction.get(junctionLocation) || [];
    traps.push(trap);
    trapsByJunction.set(junctionLocation, traps);
  }

  for (const [junctionLocation, traps] of trapsByJunction) {
    const base = junctionPoints.get(junctionLocation);
    if (!base) continue;
    const freePorts = g9FreeGridPorts(trace, junctionLocation, junctionPoints);
    for (const [index, trap] of traps.entries()) {
      const direction = freePorts[index % freePorts.length];
      const spacing = 0.72 + 0.16 * Math.floor(index / freePorts.length);
      repaired[`trap:${trap.id}`] = {
        x: base.x + direction.x * spacing,
        y: base.y + direction.y * spacing,
      };
    }
  }

  return repaired;
}

function firstConnectedJunctionLocation(trace, trapLocation) {
  for (const segment of trace?.topology?.segments || []) {
    if (segment.from === trapLocation && segment.to?.startsWith("junction:")) return segment.to;
    if (segment.to === trapLocation && segment.from?.startsWith("junction:")) return segment.from;
  }
  return null;
}

function g9FreeGridPorts(trace, junctionLocation, junctionPoints) {
  const base = junctionPoints.get(junctionLocation);
  const bounds = layoutPointBounds([...junctionPoints.values()]);
  const used = new Set();
  for (const segment of trace?.topology?.segments || []) {
    const otherLocation = segment.from === junctionLocation
      ? segment.to
      : segment.to === junctionLocation
        ? segment.from
        : null;
    if (!otherLocation?.startsWith("junction:")) continue;
    const direction = gridDirection(base, junctionPoints.get(otherLocation));
    if (direction) used.add(directionKey(direction));
  }

  const preferences = [];
  if (base.y === bounds.minY) preferences.push({ x: 0, y: -1 });
  if (base.x === bounds.maxX) preferences.push({ x: 1, y: 0 });
  if (base.y === bounds.maxY) preferences.push({ x: 0, y: 1 });
  if (base.x === bounds.minX) preferences.push({ x: -1, y: 0 });
  preferences.push({ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 });

  const freePorts = [];
  for (const direction of preferences) {
    const key = directionKey(direction);
    if (used.has(key) || freePorts.some((port) => directionKey(port) === key)) continue;
    freePorts.push(direction);
  }
  return freePorts.length ? freePorts : [{ x: 0, y: -1 }];
}

function layoutPointBounds(points) {
  return {
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

function gridDirection(from, to) {
  if (!from || !to) return null;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return null;
  if (Math.abs(dx) >= Math.abs(dy)) return { x: Math.sign(dx) || 1, y: 0 };
  return { x: 0, y: Math.sign(dy) || 1 };
}

function directionKey(direction) {
  return `${direction.x},${direction.y}`;
}

function sameRawLayoutPoint(left, right) {
  return Boolean(left && right && Math.abs(left.x - right.x) < 0.001 && Math.abs(left.y - right.y) < 0.001);
}

export function alignJunctionsToTrapPorts(trace, traps, junctions) {
  if (trace.run?.machine === "G9" || trace.run?.machine === "H6") return;
  for (const junction of trace.topology.junctions || []) {
    const junctionLocation = `junction:${junction.id}`;
    const junctionPoint = junctions.get(junctionLocation);
    if (!junctionPoint) continue;
    const verticalPortXs = [];
    const horizontalPortYs = [];
    for (const segment of trace.topology.segments || []) {
      const trapLocation = segment.from?.startsWith("trap:") ? segment.from : segment.to?.startsWith("trap:") ? segment.to : null;
      if (!trapLocation || (segment.from !== junctionLocation && segment.to !== junctionLocation)) continue;
      const trap = trace.topology.traps?.find((item) => `trap:${item.id}` === trapLocation);
      const trapPoint = traps.get(trapLocation);
      if (!trap || !trapPoint) continue;
      const portPoint = trapConnectionPoint(trap, trapPoint, `segment:${segment.id}`);
      const dx = Math.abs(trapPoint.x - junctionPoint.x);
      const dy = Math.abs(trapPoint.y - junctionPoint.y);
      if (dy >= dx) verticalPortXs.push(portPoint.x);
      else horizontalPortYs.push(portPoint.y);
    }
    if (verticalPortXs.length) junctionPoint.x = average(verticalPortXs);
    if (horizontalPortYs.length) junctionPoint.y = average(horizontalPortYs);
  }
}

export function alignTrapPortsToFixedJunctions(trace, traps, junctions) {
  if (trace.run?.machine !== "G9") return;
  for (const segment of trace.topology.segments || []) {
    const trapLocation = segment.from?.startsWith("trap:")
      ? segment.from
      : segment.to?.startsWith("trap:")
        ? segment.to
        : null;
    const junctionLocation = segment.from?.startsWith("junction:")
      ? segment.from
      : segment.to?.startsWith("junction:")
        ? segment.to
        : null;
    if (!trapLocation || !junctionLocation) continue;

    const trap = trace.topology.traps?.find((item) => `trap:${item.id}` === trapLocation);
    const trapPoint = traps.get(trapLocation);
    const junctionPoint = junctions.get(junctionLocation);
    if (!trap || !trapPoint || !junctionPoint) continue;

    const portPoint = trapConnectionPoint(trap, trapPoint, `segment:${segment.id}`);
    const dx = Math.abs(trapPoint.x - junctionPoint.x);
    const dy = Math.abs(trapPoint.y - junctionPoint.y);
    if (dy >= dx) {
      trapPoint.x += junctionPoint.x - portPoint.x;
    } else {
      trapPoint.y += junctionPoint.y - portPoint.y;
    }
  }
}

function assignTrapAngles(trace, traps, junctions) {
  if (trace.run?.machine !== "H6") return;
  for (const trap of trace.topology.traps || []) {
    const trapPoint = traps.get(`trap:${trap.id}`);
    if (!trapPoint) continue;
    trapPoint.angle = trapAxisAngle(trace, trap, trapPoint, junctions);
  }
}

export function trapAxisAngle(trace, trap, trapPoint, junctions) {
  const trapLocation = `trap:${trap.id}`;
  const sidePoints = { L: [], R: [] };
  for (const segment of trace.topology?.segments || []) {
    if (segment.from !== trapLocation && segment.to !== trapLocation) continue;
    const otherLocation = segment.from === trapLocation ? segment.to : segment.from;
    const otherPoint = junctions.get(otherLocation);
    if (!otherPoint) continue;
    sidePoints[trapEndpointSide(trap, `segment:${segment.id}`)].push(otherPoint);
  }

  const leftPoint = averagePoint(sidePoints.L);
  const rightPoint = averagePoint(sidePoints.R);
  if (leftPoint && rightPoint && distance(leftPoint, rightPoint) > 0.001) {
    return Math.atan2(rightPoint.y - leftPoint.y, rightPoint.x - leftPoint.x);
  }

  if (rightPoint && distance(trapPoint, rightPoint) > 0.001) {
    return Math.atan2(rightPoint.y - trapPoint.y, rightPoint.x - trapPoint.x);
  }
  if (leftPoint && distance(trapPoint, leftPoint) > 0.001) {
    return Math.atan2(trapPoint.y - leftPoint.y, trapPoint.x - leftPoint.x);
  }
  return Number.isFinite(trapPoint?.angle) ? trapPoint.angle : 0;
}

function averagePoint(points) {
  if (!points.length) return null;
  return {
    x: average(points.map((point) => point.x)),
    y: average(points.map((point) => point.y)),
  };
}

function scaleLayoutPoint(point, minX, maxX, minY, maxY, marginX, marginY, width, height) {
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const availableX = Math.max(1, width - marginX * 2);
  const availableY = Math.max(1, height - marginY * 2);
  const scale = Math.min(availableX / spanX, availableY / spanY);
  const usedX = spanX * scale;
  const usedY = spanY * scale;
  const offsetX = (width - usedX) / 2;
  const offsetY = (height - usedY) / 2;
  return {
    x: offsetX + (point.x - minX) * scale,
    y: offsetY + (point.y - minY) * scale,
  };
}

function resolveNodePoint(traps, junctions, location) {
  return traps.get(location) || junctions.get(location) || null;
}

function resolveSegmentNodePoint(traps, junctions, traceTraps, location, segmentId) {
  if (location?.startsWith("trap:")) {
    const trap = traceTraps.find((item) => `trap:${item.id}` === location);
    const trapPoint = traps.get(location);
    if (!trap || !trapPoint) return trapPoint || null;
    return trapConnectionPoint(trap, trapPoint, `segment:${segmentId}`);
  }
  return resolveNodePoint(traps, junctions, location);
}

function trapEndpointSide(trap, segmentLocation) {
  const segmentId = segmentLocation.split(":")[1];
  return trap.orientation?.[segmentId] === "R" ? "R" : "L";
}

function resolveLocationPoint(layout, location) {
  return layout.traps?.get(location) || layout.junctions?.get(location) || layout.segments?.get(location) || null;
}

function drawBackground(context, canvas) {
  context.fillStyle = cssColor("--color-canvas");
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.strokeStyle = "rgba(255, 255, 255, 0.024)";
  context.lineWidth = 1;
  const grid = Math.max(42, Math.floor(canvas.width / 18));
  for (let x = grid; x < canvas.width; x += grid) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, canvas.height);
    context.stroke();
  }
  for (let y = grid; y < canvas.height; y += grid) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(canvas.width, y);
    context.stroke();
  }
  context.strokeStyle = "rgba(255, 255, 255, 0.055)";
  context.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);
  context.restore();
}

function drawSegments(context, trace, layout, state) {
  const activeMotion = new Set(
    state.activeEvents.filter((event) => MOTION_TYPES.has(event.type)).flatMap((event) => [event.source, event.target]),
  );

  for (const segment of trace.topology.segments) {
    const points = segmentDrawPoints(layout, segment);
    if (points.length < 2) continue;
    const segmentKey = `segment:${segment.id}`;
    const isActive = activeMotion.has(segmentKey);

    context.save();
    context.strokeStyle = "rgba(0, 0, 0, 0.74)";
    context.lineWidth = isActive ? RENDER_SIZES.activeSegmentOuterWidth : RENDER_SIZES.segmentOuterWidth;
    context.lineCap = "round";
    context.lineJoin = "round";
    strokePolyline(context, points);

    context.strokeStyle = isActive ? "rgba(100, 210, 255, 0.36)" : "rgba(255, 255, 255, 0.105)";
    context.lineWidth = (isActive ? RENDER_SIZES.activeSegmentWidth : RENDER_SIZES.segmentWidth) + 7;
    strokePolyline(context, points);

    if (isActive) {
      context.shadowColor = cssColor("--color-move");
      context.shadowBlur = 16;
    }
    context.strokeStyle = isActive ? cssColor("--color-move") : cssColor("--color-segment");
    context.lineWidth = isActive ? RENDER_SIZES.activeSegmentWidth : RENDER_SIZES.segmentWidth;
    strokePolyline(context, points);

    context.shadowBlur = 0;
    context.strokeStyle = isActive ? "rgba(255, 255, 255, 0.54)" : "rgba(255, 255, 255, 0.2)";
    context.lineWidth = 1.4;
    strokePolyline(context, points);
    context.restore();
  }
}

function drawTraps(context, trace, layout) {
  for (const trap of trace.topology.traps) {
    const point = layout.traps.get(`trap:${trap.id}`);
    if (!point) continue;
    drawTrapChain(context, trap, point);
  }
}

function drawTrapChain(context, trap, point) {
  const width = point.width;
  const height = RENDER_SIZES.trapHeight;
  const angle = Number.isFinite(point.angle) ? point.angle : 0;
  context.save();
  context.translate(point.x, point.y);
  context.rotate(angle);
  context.shadowColor = "rgba(94, 143, 242, 0.2)";
  context.shadowBlur = 14;
  context.fillStyle = "rgba(13, 17, 24, 0.92)";
  context.strokeStyle = "rgba(255, 255, 255, 0.14)";
  context.lineWidth = 1.2;
  roundedRect(context, -width / 2 - 4, -height / 2 - 4, width + 8, height + 8, 8);
  context.fill();
  context.stroke();

  context.shadowBlur = 0;
  const gradient = context.createLinearGradient(-width / 2, 0, width / 2, 0);
  gradient.addColorStop(0, "rgba(94, 143, 242, 0.26)");
  gradient.addColorStop(0.5, "rgba(94, 143, 242, 0.12)");
  gradient.addColorStop(1, "rgba(94, 143, 242, 0.26)");
  context.fillStyle = gradient;
  context.strokeStyle = cssColor("--color-trap");
  context.lineWidth = 1.6;
  roundedRect(context, -width / 2, -height / 2, width, height, 5);
  context.fill();
  context.stroke();

  context.strokeStyle = "rgba(255, 255, 255, 0.24)";
  context.lineWidth = 1.2;
  context.beginPath();
  context.moveTo(-width / 2 + 8, 0);
  context.lineTo(width / 2 - 8, 0);
  context.stroke();

  for (const slot of trap.slots || []) {
    const slotX = trapSlotOffset(point, slot, trap.capacity);
    context.strokeStyle = "rgba(238, 242, 247, 0.28)";
    context.beginPath();
    context.moveTo(slotX, -height / 2);
    context.lineTo(slotX, height / 2);
    context.stroke();
  }
  context.restore();

  const labelPoint = trapLabelPoint(point, height);
  drawLabel(context, `T${trap.id}`, labelPoint.x, labelPoint.y, cssColor("--color-muted"));
}

function trapLabelPoint(point, trapHeight) {
  const axis = trapAxisUnit(point);
  const normal = { x: -axis.y, y: axis.x };
  const downwardNormal = normal.y >= 0 ? normal : { x: -normal.x, y: -normal.y };
  const offset = trapHeight / 2 + 13;
  return {
    x: point.x + downwardNormal.x * offset,
    y: point.y + downwardNormal.y * offset,
  };
}

function drawJunctions(context, trace, layout, state) {
  const activity = activeJunctionActivity(trace, layout, state);
  for (const junction of trace.topology.junctions) {
    const location = `junction:${junction.id}`;
    const point = layout.junctions.get(location);
    if (!point) continue;
    const directions = junctionDirections(trace, layout, location, point);
    const spec = junctionRenderSpec(junction, directions);
    const active = activity.get(location) || 0;
    context.save();
    if (active > 0) {
      drawActiveJunctionGlow(context, point, directions, spec, active);
    }
    context.shadowColor = "rgba(0, 0, 0, 0.5)";
    context.shadowBlur = 8;
    drawJunctionPatch(context, point, directions, spec.armLength, spec.outerWidth, "rgba(0, 0, 0, 0.74)", spec.armLineCap);
    context.shadowColor = "transparent";
    context.shadowBlur = 0;
    drawJunctionPatch(
      context,
      point,
      directions,
      spec.armLength,
      spec.channelWidth + 7,
      spec.kind === "cross" ? "rgba(255, 255, 255, 0.12)" : "rgba(255, 255, 255, 0.105)",
      spec.armLineCap,
    );
    drawJunctionPatch(context, point, directions, spec.armLength, spec.channelWidth, cssColor("--color-segment"), spec.armLineCap);
    drawJunctionPatch(context, point, directions, spec.armLength, spec.highlightWidth, "rgba(255, 255, 255, 0.2)", spec.armLineCap);
    drawJunctionMarker(context, point, directions, spec, active);
    context.restore();
  }
}

function drawActiveJunctionOverlays(context, trace, layout, state) {
  const activity = activeJunctionActivity(trace, layout, state);
  for (const junction of trace.topology.junctions) {
    const location = `junction:${junction.id}`;
    const active = activity.get(location) || 0;
    if (active <= 0) continue;
    const point = layout.junctions.get(location);
    if (!point) continue;
    const directions = junctionDirections(trace, layout, location, point);
    const spec = junctionRenderSpec(junction, directions);
    context.save();
    drawActiveJunctionGlow(context, point, directions, spec, active);
    drawJunctionMarker(context, point, directions, spec, active);
    context.restore();
  }
}

function drawActiveJunctionGlow(context, point, directions, spec, active) {
  const glow = clamp(active, 0, 1);
  context.save();
  context.shadowColor = `rgba(100, 210, 255, ${0.48 + glow * 0.28})`;
  context.shadowBlur = 16 + glow * 14;
  drawJunctionPatch(
    context,
    point,
    directions,
    spec.armLength + 3,
    spec.channelWidth + 10,
    `rgba(100, 210, 255, ${0.2 + glow * 0.25})`,
    spec.armLineCap,
  );
  context.shadowColor = "rgba(255, 209, 102, 0.42)";
  context.shadowBlur = 10 + glow * 8;
  context.fillStyle = `rgba(255, 209, 102, ${0.22 + glow * 0.2})`;
  context.beginPath();
  context.arc(point.x, point.y, spec.centerRadius + 8, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawJunctionMarker(context, point, directions, spec, active = 0) {
  if (!spec.markerRadius) return;
  context.save();
  context.shadowColor = active > 0 ? "rgba(100, 210, 255, 0.74)" : "rgba(255, 209, 102, 0.42)";
  context.shadowBlur = active > 0 ? 15 : 9;
  context.strokeStyle = active > 0 ? "rgba(194, 244, 255, 0.98)" : junctionStrokeColor(spec);
  context.lineWidth = active > 0 ? spec.markerWidth + 0.8 : spec.markerWidth;
  context.lineCap = "round";
  for (const direction of directions) {
    context.beginPath();
    context.moveTo(point.x, point.y);
    context.lineTo(point.x + direction.x * spec.markerArmLength, point.y + direction.y * spec.markerArmLength);
    context.stroke();
  }
  context.fillStyle = active > 0 ? "rgba(194, 244, 255, 0.98)" : junctionStrokeColor(spec);
  context.beginPath();
  context.arc(point.x, point.y, spec.markerRadius, 0, Math.PI * 2);
  context.fill();
  context.shadowBlur = 0;
  context.fillStyle = "rgba(7, 8, 10, 0.76)";
  context.beginPath();
  context.arc(point.x, point.y, Math.max(1.1, spec.markerRadius * 0.38), 0, Math.PI * 2);
  context.fill();
  context.restore();
}

export function activeJunctionActivity(trace, layout, state = {}) {
  const activity = new Map();
  for (const event of state.activeEvents || []) {
    if (!MOTION_TYPES.has(event.type)) continue;
    const path = activeMotionPathPoints(layout, event, state);
    const junctions = eventJunctionLocations(trace, layout, event, path);
    if (!junctions.length) continue;
    const point = motionPoint(layout, event, state.time, state);
    if (!point) continue;
    for (const location of junctions) {
      const junctionPoint = layout.junctions?.get(location) || sharedSegmentEndpoint(layout, event.source, event.target);
      if (!junctionPoint) continue;
      const radius = Math.max(RENDER_SIZES.segmentWidth * 2.2, 42);
      const pathDistance = distanceToPolyline(junctionPoint, path);
      const pathGlow = pathDistance <= RENDER_SIZES.segmentWidth * 0.75 ? 0.92 : 0;
      const intensity = Math.max(pathGlow, clamp(1 - distance(point, junctionPoint) / radius, 0, 1));
      if (intensity <= 0) continue;
      activity.set(location, Math.max(activity.get(location) || 0, intensity));
    }
  }
  return activity;
}

function eventJunctionLocations(trace, layout, event, path = []) {
  const locations = new Set();
  if (event.type === "move" && event.source?.startsWith("segment:") && event.target?.startsWith("segment:")) {
    const source = trace.topology.segments?.find((segment) => `segment:${segment.id}` === event.source);
    const target = trace.topology.segments?.find((segment) => `segment:${segment.id}` === event.target);
    const sourceEndpoints = new Set([source?.from, source?.to].filter(Boolean));
    const targetEndpoints = new Set([target?.from, target?.to].filter(Boolean));
    for (const endpoint of sourceEndpoints) {
      if (endpoint?.startsWith("junction:") && targetEndpoints.has(endpoint)) locations.add(endpoint);
    }
  }
  for (const [location, point] of layout.junctions || []) {
    if (distanceToPolyline(point, path) <= RENDER_SIZES.segmentWidth * 0.75) locations.add(location);
  }
  if (locations.size) return [...locations];
  const shared = sharedSegmentEndpoint(layout, event.source, event.target);
  if (!shared) return [];
  for (const [location, point] of layout.junctions || []) {
    if (samePoint(point, shared)) return [location];
  }
  return [];
}

function drawJunctionPatch(context, point, directions, length, width, color, lineCap) {
  drawJunctionArms(context, point, directions, length, width, color, lineCap);
  context.save();
  context.fillStyle = color;
  context.beginPath();
  context.arc(point.x, point.y, width / 2, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawJunctionArms(context, point, directions, length, width, color, lineCap = "butt") {
  if (!directions.length) return;
  context.save();
  context.strokeStyle = color;
  context.lineWidth = width;
  context.lineCap = lineCap;
  context.lineJoin = "round";
  for (const direction of directions) {
    context.beginPath();
    context.moveTo(point.x, point.y);
    context.lineTo(point.x + direction.x * length, point.y + direction.y * length);
    context.stroke();
  }
  context.restore();
}

function junctionStrokeColor(spec) {
  if (spec.kind === "straight") return "rgba(224, 186, 93, 0.82)";
  if (spec.kind === "tee") return "rgba(240, 196, 92, 0.95)";
  if (spec.kind === "cross") return "rgba(255, 209, 102, 0.98)";
  return cssColor("--color-junction");
}

export function junctionDirections(trace, layout, junctionLocation, point) {
  const directions = [];
  for (const segment of trace.topology.segments || []) {
    if (segment.from !== junctionLocation && segment.to !== junctionLocation) continue;
    const endpoints = layout.segmentEndpoints?.get(`segment:${segment.id}`);
    if (!endpoints) continue;
    const direction = junctionRouteDirection(point, endpoints, segment.from === junctionLocation);
    if (!direction) continue;
    const duplicate = directions.some(
      (item) => Math.abs(item.x - direction.x) < 0.08 && Math.abs(item.y - direction.y) < 0.08,
    );
    if (!duplicate) directions.push(direction);
  }
  return directions;
}

function junctionRouteDirection(point, endpoints, junctionIsStart) {
  const route = endpoints.route || [endpoints.start, endpoints.end].filter(Boolean);
  const adjacent = junctionAdjacentRoutePoint(point, route);
  const fallback = junctionIsStart ? endpoints.end : endpoints.start;
  return normalizedDirection(point, adjacent || fallback);
}

function junctionAdjacentRoutePoint(point, route) {
  if (!point || !route || route.length < 2) return null;
  for (let index = 0; index < route.length; index += 1) {
    if (!samePoint(point, route[index])) continue;
    const next = route[index + 1];
    if (next && distance(point, next) > 0) return next;
    const previous = route[index - 1];
    if (previous && distance(point, previous) > 0) return previous;
  }
  return null;
}

function normalizedDirection(from, to) {
  if (!from || !to) return null;
  const length = distance(from, to);
  if (length === 0) return null;
  return { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
}

function drawActiveEvents(context, layout, state) {
  for (const event of state.activeEvents) {
    if (MOTION_TYPES.has(event.type)) {
      const path = activeMotionPathPoints(layout, event, state);
      const point = motionPoint(layout, event, state.time, state);
      if (!point) continue;
      drawMotionPath(context, path);
      drawSwapCue(context, layout, event, state);
      context.save();
      context.shadowColor = cssColor("--color-move");
      context.shadowBlur = 18;
      context.strokeStyle = cssColor("--color-move");
      context.lineWidth = 2;
      context.beginPath();
      context.arc(point.x, point.y, 24, 0, Math.PI * 2);
      context.stroke();
      context.restore();
      continue;
    }

    const point = resolveLocationPoint(layout, event.target);
    if (!point) continue;
    drawGateLaser(context, layout, state, event);
  }
}

function drawSwapCue(context, layout, event, state = null) {
  const path = splitInternalSwapPoints(layout, event, state);
  if (path.length < 2) return;
  context.save();
  context.strokeStyle = "rgba(230, 186, 96, 0.88)";
  context.lineWidth = 3;
  context.setLineDash([4, 5]);
  context.lineCap = "round";
  strokePolyline(context, path);
  context.setLineDash([]);
  const midpoint = pointAlongPolyline(path, 0.5);
  if (!midpoint) return;
  context.fillStyle = "rgba(9, 11, 15, 0.9)";
  context.strokeStyle = cssColor("--color-warning");
  context.lineWidth = 1;
  roundedRect(context, midpoint.x - 18, midpoint.y - 24, 36, 16, 5);
  context.fill();
  context.stroke();
  drawLabel(context, "SWAP", midpoint.x, midpoint.y - 16, cssColor("--color-warning"));
  context.restore();
}

function drawIons(context, trace, layout, state) {
  const offsets = new Map();
  const showLabels = trace.particles.length <= 64;

  for (const particle of trace.particles) {
    const swapOverride = activeSplitSwapOverride(layout, state, particle.id);
    const activeMotion = state.activeEvents.find(
      (event) => MOTION_TYPES.has(event.type) && event.ions.includes(particle.id),
    );
    const location = state.locations.get(particle.id) || particle.initial_location;
    const basePoint = swapOverride?.point || (activeMotion
      ? motionPoint(layout, activeMotion, state.time, state)
      : particlePoint(layout, trace, state, particle, location));

    if (!basePoint) continue;
    const offsetKey = activeMotion ? `active:${activeMotion.id}` : location;
    const offsetIndex = offsets.get(offsetKey) || 0;
    offsets.set(offsetKey, offsetIndex + 1);
    const point = ionRenderPoint(basePoint, location, activeMotion, offsetIndex);

    const radius = activeMotion ? RENDER_SIZES.activeIonRadius : RENDER_SIZES.ionRadius;
    drawIonBody(context, particle.id, point, radius, Boolean(activeMotion || swapOverride));

    if (showLabels) {
      drawIonLabel(context, particle.id, point, radius);
    }
  }
}

export function motionPoint(layout, event, time, state = null) {
  const group = continuousMotionGroup(layout, event, state);
  if (group) {
    return pointAlongPolyline(group.path, eventProgress({ start: group.start, end: group.end }, time));
  }
  const path = eventMotionPathPoints(layout, event, state);
  return pointAlongPolyline(path, motionTravelProgress(event, time, path, layout.motionSpeedPxPerCycle));
}

function activeMotionPathPoints(layout, event, state = null) {
  return continuousMotionGroup(layout, event, state)?.path || eventMotionPathPoints(layout, event, state);
}

function eventMotionPathPoints(layout, event, state = null) {
  return isSplitSwapEvent(event) ? splitPrimaryMotionPathPoints(layout, event, state) : motionPathPoints(layout, event, state);
}

function continuousMotionGroup(layout, event, state = null) {
  if (!MOTION_TYPES.has(event?.type)) return null;
  const groupEvents = consecutiveMotionEvents(layout, event);
  if (groupEvents.length <= 1) return null;
  const path = compactPath(groupEvents.flatMap((item) => eventMotionPathPoints(layout, item, state)));
  if (path.length < 2 || polylineLength(path) <= 0) return null;
  return {
    events: groupEvents,
    path,
    start: groupEvents[0].start,
    end: groupEvents[groupEvents.length - 1].end,
  };
}

function consecutiveMotionEvents(layout, event) {
  const ion = event?.ions?.[0];
  if (ion === undefined || ion === null) return [event].filter(Boolean);
  const motionEvents = (layout.traceEventsFallback || [])
    .filter((item) => MOTION_TYPES.has(item.type) && (item.ions || []).includes(ion))
    .sort((left, right) => Number(left.start || 0) - Number(right.start || 0) || Number(left.id || 0) - Number(right.id || 0));
  const index = motionEvents.findIndex((item) => item.id === event.id);
  if (index < 0) return [event];

  let first = index;
  while (first > 0 && areConsecutiveMotionEvents(motionEvents[first - 1], motionEvents[first], ion)) {
    first -= 1;
  }

  let last = index;
  while (last < motionEvents.length - 1 && areConsecutiveMotionEvents(motionEvents[last], motionEvents[last + 1], ion)) {
    last += 1;
  }

  return motionEvents.slice(first, last + 1);
}

function areConsecutiveMotionEvents(left, right, ion) {
  return (
    left &&
    right &&
    (left.ions || []).includes(ion) &&
    (right.ions || []).includes(ion) &&
    left.target === right.source &&
    Math.abs(Number(left.end || 0) - Number(right.start || 0)) < 0.001
  );
}

function activeSplitSwapOverride(layout, state, ionId) {
  for (const event of state.activeEvents || []) {
    const point = activeSplitSwapPoint(layout, event, state, ionId);
    if (point) return { event, point };
  }
  return null;
}

function isSplitSwapEvent(event) {
  return event?.type === "split" && Number(event.metadata?.swap_count || 0) > 0 && (event.metadata?.swap_ions || []).length === 2;
}

function splitPrimaryMotionPathPoints(layout, event, state = null) {
  const swapInfo = splitSwapInfo(layout, event, state || {});
  if (!swapInfo) return motionPathPoints(layout, event, state);
  const firstPoint = trapSlotPoint(swapInfo.trapPoint, swapInfo.firstSlot, swapInfo.trap.capacity);
  const secondPoint = trapSlotPoint(swapInfo.trapPoint, swapInfo.secondSlot, swapInfo.trap.capacity);
  const exitPath = splitExitPathPoints(layout, event, state);
  return compactPath([firstPoint, secondPoint, ...(samePoint(secondPoint, exitPath[0]) ? exitPath.slice(1) : exitPath)]);
}

function splitExitPathPoints(layout, event, state = null) {
  const swapInfo = splitSwapInfo(layout, event, state || {});
  const endpointSlot = swapInfo ? endpointSlotIndex(swapInfo.trap, event.target) : null;
  const slotPath = swapInfo
    ? slotWalkPoints(swapInfo.trapPoint, swapInfo.trap.capacity, swapInfo.secondSlot, endpointSlot)
    : [];
  const endpoint = slotPath.at(-1) || eventEndpointPoint(layout, event, event.source) || splitInternalSwapPoints(layout, event).at(-1);
  const exitPath = segmentEndpointToCenterPath(layout, event.target, event.source);
  if (!endpoint) return exitPath;
  if (!exitPath.length) return [endpoint];
  const path = slotPath.length ? slotPath : [endpoint];
  return compactPath([...path, ...(samePoint(endpoint, exitPath[0]) ? exitPath.slice(1) : exitPath)]);
}

function particlePoint(layout, trace, state, particle, location) {
  if (location?.startsWith("trap:")) {
    const trap = trapForLocation(trace, location);
    const trapPoint = layout.traps.get(location);
    if (!trap || !trapPoint) return trapPoint;
    const chain = state.trapChains?.get(location) || [];
    const chainIndex = chain.indexOf(particle.id);
    const slotIndex = chainIndex >= 0 ? chainIndex : particle.initial_slot || 0;
    return trapSlotPoint(trapPoint, clamp(slotIndex, 0, trap.capacity - 1), trap.capacity);
  }
  return resolveLocationPoint(layout, location);
}

function eventEndpointPoint(layout, event, location) {
  if (!location?.startsWith("trap:")) return null;
  const trap = (layout.traceTrapsFallback || []).find((item) => `trap:${item.id}` === location);
  if (!trap) return null;
  const otherLocation = event.source === location ? event.target : event.source;
  const trapPoint = layout.traps.get(location);
  if (!trapPoint) return null;
  return trapSlotPoint(trapPoint, endpointSlotIndex(trap, otherLocation), trap.capacity);
}

export function gateLaserTargets(layout, state, event) {
  return (event.ions || [])
    .map((ion) => {
      const particle = { id: ion, initial_slot: 0 };
      const point = particlePoint(layout, { topology: { traps: layout.traceTrapsFallback || [] } }, state, particle, event.target);
      return point ? { ion, point } : null;
    })
    .filter(Boolean);
}

function drawGateLaser(context, layout, state, event) {
  context.save();
  for (const { point } of gateLaserTargets(layout, state, event)) {
    context.shadowColor = cssColor("--color-gate");
    context.shadowBlur = 18;
    context.strokeStyle = "rgba(158, 227, 125, 0.52)";
    context.lineWidth = 7;
    context.beginPath();
    context.moveTo(point.x, point.y - 104);
    context.lineTo(point.x, point.y - 8);
    context.stroke();
    context.shadowBlur = 0;
    context.strokeStyle = cssColor("--color-gate");
    context.lineWidth = 2.4;
    context.beginPath();
    context.moveTo(point.x, point.y - 96);
    context.lineTo(point.x, point.y - 8);
    context.stroke();
    context.beginPath();
    context.arc(point.x, point.y, 20, 0, Math.PI * 2);
    context.stroke();
  }
  context.restore();
}

function trapForLocation(trace, location) {
  const id = Number(location.split(":")[1]);
  return trace.topology.traps.find((trap) => trap.id === id);
}

function drawMotionPath(context, path) {
  if (!path || path.length < 2) return;
  context.save();
  context.shadowColor = cssColor("--color-move");
  context.shadowBlur = 16;
  context.strokeStyle = "rgba(100, 210, 255, 0.3)";
  context.lineWidth = 14;
  context.lineCap = "round";
  context.lineJoin = "round";
  strokePolyline(context, path);
  context.shadowBlur = 0;
  context.strokeStyle = "rgba(255, 255, 255, 0.72)";
  context.lineWidth = 2;
  strokePolyline(context, path);
  context.restore();
}

export function segmentRoutePoints(start, end, fromLocation, toLocation, machineName, routingContext = {}) {
  if (machineName === "H6") return [start, end];
  const fromDirection = endpointPortDirection(fromLocation, toLocation, start, routingContext);
  const toDirection = endpointPortDirection(toLocation, fromLocation, end, routingContext);
  if (sameAxis(start, end) && endpointDirectionsFollowAxis(start, end, fromDirection, toDirection)) {
    return [start, end];
  }
  if (fromDirection || toDirection) {
    const leadDistance = junctionPortLeadDistance();
    const fromLead = fromDirection ? translatePoint(start, fromDirection, leadDistance) : start;
    const toLead = toDirection ? translatePoint(end, toDirection, leadDistance) : end;
    return compactPath([start, fromLead, ...orthogonalConnectorPoints(fromLead, toLead, fromDirection, toDirection), toLead, end]);
  }
  if (sameAxis(start, end)) return [start, end];
  if (fromLocation?.startsWith("trap:") && toLocation?.startsWith("trap:")) {
    const midY = (start.y + end.y) / 2;
    return compactPath([start, { x: start.x, y: midY }, { x: end.x, y: midY }, end]);
  }
  if (fromLocation?.startsWith("trap:")) {
    return compactPath([start, { x: start.x, y: end.y }, end]);
  }
  if (toLocation?.startsWith("trap:")) {
    return compactPath([start, { x: end.x, y: start.y }, end]);
  }
  return compactPath([start, { x: start.x, y: end.y }, end]);
}

function endpointPortDirection(location, neighborLocation, endpointPoint, routingContext) {
  if (location?.startsWith("junction:")) {
    const center = nodeCenterPoint(routingContext, location) || endpointPoint;
    const neighbor = nodeCenterPoint(routingContext, neighborLocation);
    return dominantAxisDirection(center, neighbor);
  }
  if (location?.startsWith("trap:")) {
    return null;
  }
  return null;
}

function trapForRoutingContext(routingContext, location) {
  return (routingContext?.traceTraps || []).find((trap) => `trap:${trap.id}` === location) || null;
}

function nodeCenterPoint(routingContext, location) {
  return routingContext?.traps?.get(location) || routingContext?.junctions?.get(location) || null;
}

function dominantAxisDirection(from, to) {
  if (!from || !to) return null;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return null;
  if (Math.abs(dx) >= Math.abs(dy)) return { x: Math.sign(dx) || 1, y: 0 };
  return { x: 0, y: Math.sign(dy) || 1 };
}

function junctionPortLeadDistance() {
  return RENDER_SIZES.segmentWidth * 2.2;
}

function endpointDirectionsFollowAxis(start, end, fromDirection, toDirection) {
  const forward = dominantAxisDirection(start, end);
  const backward = dominantAxisDirection(end, start);
  return (!fromDirection || sameDirection(fromDirection, forward)) && (!toDirection || sameDirection(toDirection, backward));
}

function sameDirection(a, b) {
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) < 0.001 && Math.abs(a.y - b.y) < 0.001;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function translatePoint(point, direction, distanceValue) {
  return {
    x: point.x + direction.x * distanceValue,
    y: point.y + direction.y * distanceValue,
  };
}

function orthogonalConnectorPoints(start, end, fromDirection, toDirection) {
  if (!start || !end || sameAxis(start, end)) return [];
  if (fromDirection && Math.abs(fromDirection.x) > 0) return [{ x: start.x, y: end.y }];
  if (!fromDirection && toDirection && Math.abs(toDirection.y) > 0) return [{ x: start.x, y: end.y }];
  return [{ x: end.x, y: start.y }];
}

function segmentEndpointToCenterPath(layout, segmentLocation, endpointLocationOrPoint) {
  const endpoints = layout.segmentEndpoints?.get(segmentLocation);
  const endpoint = typeof endpointLocationOrPoint === "string"
    ? segmentEndpointForLocation(layout, segmentLocation, endpointLocationOrPoint)
    : endpointLocationOrPoint;
  const route = routeFromEndpoint(endpoints, endpoint);
  if (!route.length) {
    return [endpoint, resolveLocationPoint(layout, segmentLocation)].filter(Boolean);
  }
  return subpathAlongPolyline(route, 0.5);
}

function segmentCenterToEndpointPath(layout, segmentLocation, endpointLocationOrPoint) {
  return [...segmentEndpointToCenterPath(layout, segmentLocation, endpointLocationOrPoint)].reverse();
}

function routeFromEndpoint(endpoints, endpoint) {
  if (!endpoints || !endpoint) return [];
  const route = endpoints.route || [endpoints.start, endpoints.end].filter(Boolean);
  if (!route.length) return [];
  if (samePoint(endpoint, route[0])) return route;
  if (samePoint(endpoint, route[route.length - 1])) return [...route].reverse();
  return [endpoint, ...route];
}

function subpathAlongPolyline(points, progress) {
  if (!points || points.length <= 1) return points || [];
  const lengths = [];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const length = distance(points[index - 1], points[index]);
    lengths.push(length);
    total += length;
  }
  if (total === 0) return [points[0]];

  let remaining = total * clamp(progress, 0, 1);
  const path = [points[0]];
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index];
    if (remaining <= length) {
      const localProgress = length === 0 ? 1 : remaining / length;
      path.push(interpolatePoint(points[index], points[index + 1], localProgress));
      return compactPath(path);
    }
    path.push(points[index + 1]);
    remaining -= length;
  }
  return compactPath(path);
}

function strokePolyline(context, points) {
  if (!points || points.length < 2) return;
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) {
    context.lineTo(point.x, point.y);
  }
  context.stroke();
}

function sharedSegmentEndpoint(layout, sourceSegment, targetSegment) {
  const source = layout.segmentEndpoints?.get(sourceSegment);
  const target = layout.segmentEndpoints?.get(targetSegment);
  if (!source || !target) return null;
  for (const sourcePoint of [source.start, source.end]) {
    for (const targetPoint of [target.start, target.end]) {
      if (samePoint(sourcePoint, targetPoint)) return sourcePoint;
    }
  }
  return null;
}

function segmentEndpointNearLocation(layout, segmentLocation, nodeLocation) {
  const exact = segmentEndpointForLocation(layout, segmentLocation, nodeLocation);
  if (exact) return exact;
  const node = resolveLocationPoint(layout, nodeLocation);
  if (!node) return null;
  return nearestSegmentEndpoint(layout, segmentLocation, node);
}

function segmentEndpointForLocation(layout, segmentLocation, nodeLocation) {
  const endpoints = layout.segmentEndpoints?.get(segmentLocation);
  if (!endpoints) return null;
  if (endpoints.from === nodeLocation) return endpoints.start;
  if (endpoints.to === nodeLocation) return endpoints.end;
  return null;
}

function nearestSegmentEndpoint(layout, segmentLocation, point) {
  const endpoints = layout.segmentEndpoints?.get(segmentLocation);
  if (!endpoints || !point) return null;
  return distance(endpoints.start, point) <= distance(endpoints.end, point) ? endpoints.start : endpoints.end;
}

function compactPath(points) {
  const compacted = [];
  for (const point of points) {
    if (!point) continue;
    if (compacted.length === 0 || !samePoint(compacted[compacted.length - 1], point)) {
      compacted.push(point);
    }
  }
  return compacted;
}

function samePoint(left, right) {
  return Boolean(left && right && Math.abs(left.x - right.x) < 0.001 && Math.abs(left.y - right.y) < 0.001);
}

function sameAxis(left, right) {
  return Boolean(left && right && (Math.abs(left.x - right.x) < 0.001 || Math.abs(left.y - right.y) < 0.001));
}

function distance(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function distanceToPolyline(point, path) {
  if (!point || !path?.length) return Number.POSITIVE_INFINITY;
  if (path.length === 1) return distance(point, path[0]);
  let minDistance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < path.length; index += 1) {
    minDistance = Math.min(minDistance, pointToSegmentDistance(point, path[index - 1], path[index]));
  }
  return minDistance;
}

function pointToSegmentDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return distance(point, start);
  const projection = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1);
  return distance(point, { x: start.x + dx * projection, y: start.y + dy * projection });
}

function offsetPoint(point, index) {
  if (index === 0) return point;
  const angle = index * 2.399963;
  const radius = 11 + Math.floor(index / 6) * 7;
  return {
    x: point.x + Math.cos(angle) * radius,
    y: point.y + Math.sin(angle) * radius,
  };
}

function roundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  if (typeof context.roundRect === "function") {
    context.roundRect(x, y, width, height, radius);
    return;
  }
  context.rect(x, y, width, height);
}

function drawLabel(context, text, x, y, color) {
  context.save();
  context.fillStyle = "rgba(5, 6, 7, 0.58)";
  const width = Math.max(12, String(text).length * 7 + 6);
  roundedRect(context, x - width / 2, y - 7, width, 14, 4);
  context.fill();
  context.fillStyle = color;
  context.font = "12px -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, x, y);
  context.restore();
}

function drawIonBody(context, id, point, radius, active = false) {
  const color = ionColor(id);
  const lightColor = shadeColor(color, 30);
  const darkColor = shadeColor(color, -38);
  const haloRadius = active ? radius * 2.8 : radius * 2.05;

  context.save();
  context.globalCompositeOperation = "screen";
  const halo = context.createRadialGradient(point.x, point.y, radius * 0.2, point.x, point.y, haloRadius);
  halo.addColorStop(0, active ? "rgba(255, 255, 255, 0.32)" : "rgba(255, 255, 255, 0.14)");
  halo.addColorStop(0.36, hexToRgba(color, active ? 0.34 : 0.2));
  halo.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = halo;
  context.beginPath();
  context.arc(point.x, point.y, haloRadius, 0, Math.PI * 2);
  context.fill();
  context.restore();

  context.save();
  context.shadowColor = active ? cssColor("--color-move") : "rgba(0, 0, 0, 0.48)";
  context.shadowBlur = active ? 18 : 7;
  const shell = context.createRadialGradient(
    point.x - radius * 0.28,
    point.y - radius * 0.36,
    radius * 0.12,
    point.x,
    point.y,
    radius,
  );
  shell.addColorStop(0, "rgba(255, 255, 255, 0.92)");
  shell.addColorStop(0.24, lightColor);
  shell.addColorStop(0.68, color);
  shell.addColorStop(1, darkColor);
  context.fillStyle = shell;
  context.beginPath();
  context.arc(point.x, point.y, radius, 0, Math.PI * 2);
  context.fill();

  context.shadowBlur = 0;
  context.strokeStyle = active ? "rgba(214, 246, 255, 0.88)" : "rgba(244, 248, 255, 0.34)";
  context.lineWidth = active ? 1.6 : 1.15;
  context.beginPath();
  context.arc(point.x, point.y, radius - 0.45, 0, Math.PI * 2);
  context.stroke();

  context.globalAlpha = active ? 0.86 : 0.62;
  context.fillStyle = "rgba(255, 255, 255, 0.82)";
  context.beginPath();
  context.arc(point.x - radius * 0.3, point.y - radius * 0.36, Math.max(1.1, radius * 0.16), 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawIonLabel(context, id, point, radius) {
  const spec = ionLabelSpec(id, radius);
  context.save();
  context.font = `800 ${spec.fontSize}px -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.lineWidth = 2.2;
  context.strokeStyle = "rgba(0, 0, 0, 0.72)";
  context.fillStyle = "#f8fbff";
  context.strokeText(spec.text, point.x + spec.xOffset, point.y + spec.yOffset);
  context.fillText(spec.text, point.x + spec.xOffset, point.y + spec.yOffset);
  context.restore();
}

function ionColor(id) {
  const palette = ["#57c7b8", "#f07178", "#c678dd", "#e5c07b", "#61afef", "#98c379", "#d5a84f"];
  return palette[Math.abs(id) % palette.length];
}

function shadeColor(hex, percent) {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  const amount = Math.round(2.55 * percent);
  const red = clamp((value >> 16) + amount, 0, 255);
  const green = clamp(((value >> 8) & 0xff) + amount, 0, 255);
  const blue = clamp((value & 0xff) + amount, 0, 255);
  return `#${(0x1000000 + red * 0x10000 + green * 0x100 + blue).toString(16).slice(1)}`;
}

function hexToRgba(hex, alpha) {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  const red = (value >> 16) & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

export function resetCssColorCache() {
  cssColorCache.clear();
}

export function cssColor(name) {
  if (cssColorCache.has(name)) return cssColorCache.get(name);
  if (globalThis.document && globalThis.getComputedStyle) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (value) {
      cssColorCache.set(name, value);
      return value;
    }
  }
  const fallback = FALLBACK_COLORS[name] || "#ffffff";
  cssColorCache.set(name, fallback);
  return fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
