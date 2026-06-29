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

export const RENDER_SIZES = Object.freeze({
  ionRadius: 8,
  activeIonRadius: 9,
  segmentWidth: 20,
  activeSegmentWidth: 26,
  segmentOuterWidth: 28,
  activeSegmentOuterWidth: 36,
  motionPathWidth: 28,
  trapHeight: 28,
  trapPortGap: 14,
  trapPortRadius: 5,
  couplerWidth: 20,
  couplerLength: 16,
  junctionRadius: 10,
});

export function createRenderer(canvas) {
  const context = canvas.getContext("2d", { alpha: false });
  let trace = null;
  let layout = null;

  return {
    setTrace(nextTrace) {
      trace = nextTrace;
      resizeCanvas(canvas);
      layout = computeLayout(canvas, trace);
    },
    draw(state) {
      if (!trace || !layout) return;
      const resized = resizeCanvas(canvas);
      if (resized) layout = computeLayout(canvas, trace);

      context.clearRect(0, 0, canvas.width, canvas.height);
      drawBackground(context, canvas);
      drawSegments(context, trace, layout, state);
      drawChannelTerminals(context, trace, layout, state);
      drawTraps(context, trace, layout);
      drawTrapPorts(context, trace, layout);
      drawJunctions(context, trace, layout);
      drawActiveEvents(context, layout, state);
      drawIons(context, trace, layout, state);
    },
  };
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

export function trapSlotPoint(trapPoint, slotIndex, capacity) {
  const usableWidth = trapPoint.width * 0.8;
  const left = trapPoint.x - usableWidth / 2;
  const step = capacity <= 1 ? 0 : usableWidth / (capacity - 1);
  return { x: left + step * slotIndex, y: trapPoint.y };
}

export function trapConnectionPoint(trap, trapPoint, segmentLocation) {
  const side = trapEndpointSide(trap, segmentLocation);
  return trapPortPoints(trapPoint)[side];
}

export function trapPortPoints(trapPoint) {
  const offset = trapPoint.width / 2 + RENDER_SIZES.trapPortGap;
  return {
    L: { x: trapPoint.x - offset, y: trapPoint.y },
    R: { x: trapPoint.x + offset, y: trapPoint.y },
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

  const lengths = [];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const length = distance(points[index - 1], points[index]);
    lengths.push(length);
    total += length;
  }
  if (total === 0) return points[points.length - 1];

  let target = total * clamp(progress, 0, 1);
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index];
    if (target <= length) {
      const localProgress = length === 0 ? 1 : target / length;
      return interpolatePoint(points[index], points[index + 1], localProgress);
    }
    target -= length;
  }
  return points[points.length - 1];
}

export function motionPathPoints(layout, event) {
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
    const swapPath = splitInternalSwapPoints(layout, event);
    const exitPath = segmentEndpointToCenterPath(layout, event.target, event.source);
    return compactPath([...(swapPath.length ? swapPath : [start]), ...exitPath]);
  }

  if (event.source?.startsWith("segment:") && event.target?.startsWith("trap:")) {
    return compactPath([...segmentCenterToEndpointPath(layout, event.source, event.target), end]);
  }

  return compactPath([start, end]);
}

export function splitInternalSwapPoints(layout, event) {
  const swapHops = Number(event.metadata?.swap_hops || 0);
  const swapCount = Number(event.metadata?.swap_count || 0);
  if (event.type !== "split" || swapCount <= 0 || swapHops <= 0 || !event.source?.startsWith("trap:")) {
    return [];
  }
  const trap = (layout.traceTrapsFallback || []).find((item) => `trap:${item.id}` === event.source);
  const trapPoint = layout.traps.get(event.source);
  if (!trap || !trapPoint) return [];
  const endpointSlot = endpointSlotIndex(trap, event.target);
  const startSlot =
    event.metadata?.endpoint === "R"
      ? Math.max(0, endpointSlot - swapHops)
      : Math.min(trap.capacity - 1, endpointSlot + swapHops);
  return [
    trapSlotPoint(trapPoint, startSlot, trap.capacity),
    trapSlotPoint(trapPoint, endpointSlot, trap.capacity),
  ];
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
    kind,
    label: junction.junction_type || `J${armCount}`,
  };
}

function resizeCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const scale = globalThis.devicePixelRatio || 1;
  const width = Math.max(320, Math.floor(rect.width * scale));
  const height = Math.max(240, Math.floor(rect.height * scale));
  if (canvas.width === width && canvas.height === height) return false;
  canvas.width = width;
  canvas.height = height;
  return true;
}

function computeLayout(canvas, trace) {
  const width = canvas.width;
  const height = canvas.height;
  const marginX = Math.max(92, width * 0.1);
  const marginY = Math.max(84, height * 0.12);
  const traps = new Map();
  const junctions = new Map();
  const segments = new Map();
  const segmentEndpoints = new Map();
  const rawLayout = trace.topology.layout || {};
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
    traps.set(location, { x, y, width: Math.max(72, Math.min(150, 18 * trap.capacity + 28)) });
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

  for (const segment of trace.topology.segments) {
    const start = resolveSegmentNodePoint(traps, junctions, trace.topology.traps, segment.from, segment.id);
    const end = resolveSegmentNodePoint(traps, junctions, trace.topology.traps, segment.to, segment.id);
    if (!start || !end) continue;
    const key = `segment:${segment.id}`;
    const route = segmentRoutePoints(start, end, segment.from, segment.to, trace.run?.machine);
    segments.set(key, pointAlongPolyline(route, 0.5));
    segmentEndpoints.set(key, { start, end, from: segment.from, to: segment.to, route });
  }

  return { traps, junctions, segments, segmentEndpoints, traceTrapsFallback: trace.topology.traps };
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
  return layout.traps.get(location) || layout.junctions.get(location) || layout.segments.get(location) || null;
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

function drawChannelTerminals(context, trace, layout, state) {
  const activeMotion = new Set(
    state.activeEvents.filter((event) => MOTION_TYPES.has(event.type)).flatMap((event) => [event.source, event.target]),
  );

  for (const segment of trace.topology.segments) {
    const key = `segment:${segment.id}`;
    const endpoints = layout.segmentEndpoints?.get(key);
    if (!endpoints) continue;
    const route = endpoints.route || [endpoints.start, endpoints.end].filter(Boolean);
    const isActive = activeMotion.has(key);
    drawTerminalForEndpoint(context, route, endpoints.start, endpoints.from, isActive);
    drawTerminalForEndpoint(context, [...route].reverse(), endpoints.end, endpoints.to, isActive);
  }
}

function drawTerminalForEndpoint(context, route, point, location, active) {
  if (!point) return;
  if (location?.startsWith("trap:")) {
    const next = route?.[1] || point;
    drawTrapCoupler(context, point, next, active);
  }
}

function drawTrapCoupler(context, point, nextPoint, active) {
  const horizontal = Math.abs((nextPoint?.x ?? point.x) - point.x) >= Math.abs((nextPoint?.y ?? point.y) - point.y);
  const length = RENDER_SIZES.couplerLength;
  const width = RENDER_SIZES.couplerWidth;
  const x = point.x - (horizontal ? length / 2 : width / 2);
  const y = point.y - (horizontal ? width / 2 : length / 2);

  context.save();
  context.fillStyle = active ? "rgba(100, 210, 255, 0.32)" : "rgba(124, 135, 152, 0.36)";
  context.strokeStyle = active ? cssColor("--color-move") : "rgba(255, 255, 255, 0.24)";
  context.lineWidth = active ? 1.8 : 1.2;
  context.shadowColor = active ? cssColor("--color-move") : "rgba(0, 0, 0, 0.42)";
  context.shadowBlur = active ? 12 : 4;
  roundedRect(context, x, y, horizontal ? length : width, horizontal ? width : length, 5);
  context.fill();
  context.stroke();
  context.restore();
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
  context.save();
  context.shadowColor = "rgba(94, 143, 242, 0.2)";
  context.shadowBlur = 14;
  context.fillStyle = "rgba(13, 17, 24, 0.92)";
  context.strokeStyle = "rgba(255, 255, 255, 0.14)";
  context.lineWidth = 1.2;
  roundedRect(context, point.x - width / 2 - 4, point.y - height / 2 - 4, width + 8, height + 8, 8);
  context.fill();
  context.stroke();

  context.shadowBlur = 0;
  const gradient = context.createLinearGradient(point.x - width / 2, point.y, point.x + width / 2, point.y);
  gradient.addColorStop(0, "rgba(94, 143, 242, 0.26)");
  gradient.addColorStop(0.5, "rgba(94, 143, 242, 0.12)");
  gradient.addColorStop(1, "rgba(94, 143, 242, 0.26)");
  context.fillStyle = gradient;
  context.strokeStyle = cssColor("--color-trap");
  context.lineWidth = 1.6;
  roundedRect(context, point.x - width / 2, point.y - height / 2, width, height, 5);
  context.fill();
  context.stroke();

  context.strokeStyle = "rgba(255, 255, 255, 0.24)";
  context.lineWidth = 1.2;
  context.beginPath();
  context.moveTo(point.x - width / 2 + 8, point.y);
  context.lineTo(point.x + width / 2 - 8, point.y);
  context.stroke();

  for (const slot of trap.slots || []) {
    const slotPoint = trapSlotPoint(point, slot, trap.capacity);
    context.strokeStyle = "rgba(238, 242, 247, 0.28)";
    context.beginPath();
    context.moveTo(slotPoint.x, point.y - height / 2);
    context.lineTo(slotPoint.x, point.y + height / 2);
    context.stroke();
  }

  drawLabel(context, `T${trap.id}`, point.x, point.y + 24, cssColor("--color-muted"));
  context.restore();
}

function drawTrapPorts(context, trace, layout) {
  for (const trap of trace.topology.traps) {
    const point = layout.traps.get(`trap:${trap.id}`);
    if (!point) continue;
    const ports = trapPortPoints(point);
    const connected = trapConnectedPortSides(trap);
    for (const side of ["L", "R"]) {
      drawTrapNeck(context, point, ports[side], side, connected.has(side));
      drawTrapPort(context, ports[side], side, connected.has(side));
    }
  }
}

function drawTrapNeck(context, trapPoint, portPoint, side, connected) {
  if (!connected) return;
  const sign = side === "R" ? 1 : -1;
  const edge = { x: trapPoint.x + sign * trapPoint.width / 2, y: trapPoint.y };
  context.save();
  context.strokeStyle = "rgba(0, 0, 0, 0.62)";
  context.lineWidth = RENDER_SIZES.couplerWidth + 6;
  context.lineCap = "round";
  context.beginPath();
  context.moveTo(edge.x, edge.y);
  context.lineTo(portPoint.x, portPoint.y);
  context.stroke();
  context.strokeStyle = "rgba(124, 135, 152, 0.42)";
  context.lineWidth = RENDER_SIZES.couplerWidth;
  context.beginPath();
  context.moveTo(edge.x, edge.y);
  context.lineTo(portPoint.x, portPoint.y);
  context.stroke();
  context.strokeStyle = "rgba(255, 255, 255, 0.18)";
  context.lineWidth = 1.1;
  context.beginPath();
  context.moveTo(edge.x, edge.y);
  context.lineTo(portPoint.x, portPoint.y);
  context.stroke();
  context.restore();
}

function drawTrapPort(context, point, side, connected) {
  context.save();
  context.fillStyle = connected ? "rgba(14, 18, 24, 0.98)" : "rgba(115, 127, 145, 0.18)";
  context.strokeStyle = connected ? "rgba(100, 210, 255, 0.54)" : "rgba(115, 127, 145, 0.36)";
  context.lineWidth = connected ? 1.8 : 1;
  context.shadowColor = connected ? "rgba(100, 210, 255, 0.24)" : "transparent";
  context.shadowBlur = connected ? 8 : 0;
  context.beginPath();
  context.arc(point.x, point.y, connected ? RENDER_SIZES.trapPortRadius + 1 : RENDER_SIZES.trapPortRadius, 0, Math.PI * 2);
  context.fill();
  context.stroke();

  context.shadowBlur = 0;
  context.fillStyle = connected ? "rgba(100, 210, 255, 0.92)" : "rgba(168, 179, 195, 0.48)";
  context.beginPath();
  context.arc(point.x, point.y, 2.2, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawJunctions(context, trace, layout) {
  for (const junction of trace.topology.junctions) {
    const location = `junction:${junction.id}`;
    const point = layout.junctions.get(location);
    if (!point) continue;
    const directions = junctionDirections(trace, layout, location, point);
    const spec = junctionRenderSpec(junction, directions);
    const radius = RENDER_SIZES.junctionRadius;
    context.save();
    context.shadowColor = "rgba(0, 0, 0, 0.55)";
    context.shadowBlur = 8;
    context.fillStyle = "rgba(5, 6, 7, 0.98)";
    context.beginPath();
    context.arc(point.x, point.y, radius + 7, 0, Math.PI * 2);
    context.fill();
    context.shadowColor = "rgba(240, 196, 92, 0.26)";
    context.shadowBlur = spec.kind === "cross" ? 16 : 11;
    context.fillStyle = "rgba(11, 12, 13, 0.98)";
    context.strokeStyle = junctionStrokeColor(spec);
    context.lineWidth = 1.6;
    context.beginPath();
    if (spec.kind === "cross") {
      roundedRect(context, point.x - radius - 2, point.y - radius - 2, (radius + 2) * 2, (radius + 2) * 2, 7);
    } else {
      context.arc(point.x, point.y, radius + 3, 0, Math.PI * 2);
    }
    context.fill();
    context.stroke();
    context.shadowBlur = 0;

    context.strokeStyle = junctionStrokeColor(spec);
    context.lineWidth = 4.2;
    context.lineCap = "round";
    for (const direction of directions) {
      context.beginPath();
      context.moveTo(point.x, point.y);
      context.lineTo(point.x + direction.x * (radius + 2), point.y + direction.y * (radius + 2));
      context.stroke();
    }

    context.fillStyle = "rgba(5, 6, 7, 0.98)";
    context.beginPath();
    context.arc(point.x, point.y, spec.kind === "straight" ? 2.4 : 3.1, 0, Math.PI * 2);
    context.fill();

    context.fillStyle = junctionStrokeColor(spec);
    for (const direction of directions) {
      context.beginPath();
      context.arc(point.x + direction.x * (radius + 1), point.y + direction.y * (radius + 1), 2.2, 0, Math.PI * 2);
      context.fill();
    }

    context.fillStyle = cssColor("--color-junction");
    context.beginPath();
    context.arc(point.x, point.y, spec.kind === "straight" ? 2.2 : 2.8, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }
}

function junctionStrokeColor(spec) {
  if (spec.kind === "straight") return "rgba(224, 186, 93, 0.82)";
  if (spec.kind === "tee") return "rgba(240, 196, 92, 0.95)";
  if (spec.kind === "cross") return "rgba(255, 209, 102, 0.98)";
  return cssColor("--color-junction");
}

function junctionDirections(trace, layout, junctionLocation, point) {
  const directions = [];
  for (const segment of trace.topology.segments || []) {
    if (segment.from !== junctionLocation && segment.to !== junctionLocation) continue;
    const endpoints = layout.segmentEndpoints?.get(`segment:${segment.id}`);
    if (!endpoints) continue;
    const other = segment.from === junctionLocation ? endpoints.end : endpoints.start;
    const length = distance(point, other);
    if (length === 0) continue;
    const direction = { x: (other.x - point.x) / length, y: (other.y - point.y) / length };
    const duplicate = directions.some(
      (item) => Math.abs(item.x - direction.x) < 0.08 && Math.abs(item.y - direction.y) < 0.08,
    );
    if (!duplicate) directions.push(direction);
  }
  return directions;
}

function drawActiveEvents(context, layout, state) {
  for (const event of state.activeEvents) {
    if (MOTION_TYPES.has(event.type)) {
      const path = motionPathPoints(layout, event);
      const point = pointAlongPolyline(path, eventProgress(event, state.time));
      if (!point) continue;
      drawMotionPath(context, path);
      drawSwapCue(context, layout, event);
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

function drawSwapCue(context, layout, event) {
  const path = splitInternalSwapPoints(layout, event);
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
    const activeMotion = state.activeEvents.find(
      (event) => MOTION_TYPES.has(event.type) && event.ions.includes(particle.id),
    );
    const location = state.locations.get(particle.id) || particle.initial_location;
    const basePoint = activeMotion
      ? motionPoint(layout, activeMotion, state.time)
      : particlePoint(layout, trace, state, particle, location);

    if (!basePoint) continue;
    const offsetKey = activeMotion ? `active:${activeMotion.id}` : location;
    const offsetIndex = offsets.get(offsetKey) || 0;
    offsets.set(offsetKey, offsetIndex + 1);
    const point = ionRenderPoint(basePoint, location, activeMotion, offsetIndex);

    context.save();
    const radius = activeMotion ? RENDER_SIZES.activeIonRadius : RENDER_SIZES.ionRadius;
    const gradient = context.createRadialGradient(point.x - radius * 0.35, point.y - radius * 0.45, 1, point.x, point.y, radius);
    gradient.addColorStop(0, "#ffffff");
    gradient.addColorStop(0.18, ionColor(particle.id));
    gradient.addColorStop(1, shadeColor(ionColor(particle.id), -24));
    context.shadowColor = activeMotion ? cssColor("--color-move") : "rgba(0, 0, 0, 0.45)";
    context.shadowBlur = activeMotion ? 16 : 5;
    context.fillStyle = gradient;
    context.strokeStyle = "rgba(16, 18, 22, 0.95)";
    context.lineWidth = 2;
    context.beginPath();
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.restore();

    if (showLabels) {
      drawIonLabel(context, particle.id, point, radius);
    }
  }
}

function motionPoint(layout, event, time) {
  const path = motionPathPoints(layout, event);
  return pointAlongPolyline(path, eventProgress(event, time));
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

function drawGateLaser(context, layout, state, event) {
  context.save();
  for (const ion of event.ions || []) {
    const particle = { id: ion, initial_slot: 0 };
    const point = particlePoint(layout, { topology: { traps: layout.traceTrapsFallback || [] } }, state, particle, event.target);
    if (!point) continue;
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

function segmentRoutePoints(start, end, fromLocation, toLocation, machineName) {
  if (machineName === "H6") return [start, end];
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

function cssColor(name) {
  if (globalThis.document && globalThis.getComputedStyle) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (value) return value;
  }
  return FALLBACK_COLORS[name] || "#ffffff";
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
