const FALLBACK_COLORS = {
  "--color-bg": "#101216",
  "--color-panel": "#181c22",
  "--color-border": "#2f3742",
  "--color-text": "#eef2f7",
  "--color-muted": "#a8b1bd",
  "--color-trap": "#4677c8",
  "--color-segment": "#657080",
  "--color-junction": "#d5a84f",
  "--color-gate": "#98c379",
  "--color-move": "#61afef",
};

const MOTION_TYPES = new Set(["split", "move", "merge"]);

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
      drawTraps(context, trace, layout);
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
  return trapSlotPoint(trapPoint, endpointSlotIndex(trap, segmentLocation), trap.capacity);
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
    return compactPath([start, shared, end]);
  }

  if (event.source?.startsWith("trap:") && event.target?.startsWith("segment:")) {
    const anchor = segmentEndpointNearLocation(layout, event.target, event.source) || nearestSegmentEndpoint(layout, event.target, start);
    return compactPath([start, anchor, end]);
  }

  if (event.source?.startsWith("segment:") && event.target?.startsWith("trap:")) {
    const anchor = segmentEndpointNearLocation(layout, event.source, event.target) || nearestSegmentEndpoint(layout, event.source, end);
    return compactPath([start, anchor, end]);
  }

  return compactPath([start, end]);
}

export function ionRenderPoint(basePoint, location, activeMotion, offsetIndex) {
  if (!basePoint) return null;
  if (!activeMotion && location?.startsWith("trap:")) return basePoint;
  return offsetPoint(basePoint, offsetIndex);
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
    const x = point ? scaleValue(point.x, minX, maxX, marginX, width - marginX) : fallbackX;
    const y = point ? scaleValue(point.y, minY, maxY, marginY, height - marginY) : height * 0.58;
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
    const x = point ? scaleValue(point.x, minX, maxX, marginX, width - marginX) : fallbackX;
    const y = point ? scaleValue(point.y, minY, maxY, marginY, height - marginY) : height * 0.34;
    junctions.set(location, { x, y });
  }

  for (const segment of trace.topology.segments) {
    const start = resolveSegmentNodePoint(traps, junctions, trace.topology.traps, segment.from, segment.id);
    const end = resolveSegmentNodePoint(traps, junctions, trace.topology.traps, segment.to, segment.id);
    if (!start || !end) continue;
    const key = `segment:${segment.id}`;
    segments.set(key, interpolatePoint(start, end, 0.5));
    segmentEndpoints.set(key, { start, end });
  }

  return { traps, junctions, segments, segmentEndpoints, traceTrapsFallback: trace.topology.traps };
}

function scaleValue(value, minInput, maxInput, minOutput, maxOutput) {
  if (maxInput === minInput) return (minOutput + maxOutput) / 2;
  return minOutput + ((value - minInput) / (maxInput - minInput)) * (maxOutput - minOutput);
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

function resolveLocationPoint(layout, location) {
  return layout.traps.get(location) || layout.junctions.get(location) || layout.segments.get(location) || null;
}

function drawBackground(context, canvas) {
  context.fillStyle = cssColor("--color-bg");
  context.fillRect(0, 0, canvas.width, canvas.height);
}

function drawSegments(context, trace, layout, state) {
  const activeMotion = new Set(
    state.activeEvents.filter((event) => MOTION_TYPES.has(event.type)).flatMap((event) => [event.source, event.target]),
  );

  for (const segment of trace.topology.segments) {
    const start = resolveLocationPoint(layout, segment.from);
    const end = resolveLocationPoint(layout, segment.to);
    if (!start || !end) continue;
    const segmentKey = `segment:${segment.id}`;
    const isActive = activeMotion.has(segmentKey);

    context.strokeStyle = isActive ? cssColor("--color-move") : cssColor("--color-segment");
    context.lineWidth = isActive ? 5 : 3;
    context.lineCap = "round";
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.stroke();
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
  const height = 26;
  context.fillStyle = "rgba(70, 119, 200, 0.22)";
  context.strokeStyle = cssColor("--color-trap");
  context.lineWidth = 1.5;
  roundedRect(context, point.x - width / 2, point.y - height / 2, width, height, 5);
  context.fill();
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
}

function drawJunctions(context, trace, layout) {
  for (const junction of trace.topology.junctions) {
    const point = layout.junctions.get(`junction:${junction.id}`);
    if (!point) continue;
    context.fillStyle = cssColor("--color-junction");
    context.beginPath();
    context.arc(point.x, point.y, 9, 0, Math.PI * 2);
    context.fill();
  }
}

function drawActiveEvents(context, layout, state) {
  for (const event of state.activeEvents) {
    if (MOTION_TYPES.has(event.type)) {
      const path = motionPathPoints(layout, event);
      const point = pointAlongPolyline(path, eventProgress(event, state.time));
      if (!point) continue;
      drawMotionPath(context, path);
      context.strokeStyle = cssColor("--color-move");
      context.lineWidth = 2;
      context.beginPath();
      context.arc(point.x, point.y, 24, 0, Math.PI * 2);
      context.stroke();
      continue;
    }

    const point = resolveLocationPoint(layout, event.target);
    if (!point) continue;
    drawGateLaser(context, layout, state, event);
  }
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

    context.fillStyle = ionColor(particle.id);
    context.strokeStyle = "rgba(16, 18, 22, 0.95)";
    context.lineWidth = 2;
    context.beginPath();
    context.arc(point.x, point.y, activeMotion ? 7 : 6, 0, Math.PI * 2);
    context.fill();
    context.stroke();

    if (showLabels) {
      drawLabel(context, String(particle.id), point.x, point.y - 10, cssColor("--color-text"));
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
  context.strokeStyle = cssColor("--color-gate");
  context.lineWidth = 3;
  for (const ion of event.ions || []) {
    const particle = { id: ion, initial_slot: 0 };
    const point = particlePoint(layout, { topology: { traps: layout.traceTrapsFallback || [] } }, state, particle, event.target);
    if (!point) continue;
    context.beginPath();
    context.moveTo(point.x, point.y - 96);
    context.lineTo(point.x, point.y - 8);
    context.stroke();
    context.beginPath();
    context.arc(point.x, point.y, 20, 0, Math.PI * 2);
    context.stroke();
  }
}

function trapForLocation(trace, location) {
  const id = Number(location.split(":")[1]);
  return trace.topology.traps.find((trap) => trap.id === id);
}

function drawMotionPath(context, path) {
  if (!path || path.length < 2) return;
  context.strokeStyle = "rgba(97, 175, 239, 0.42)";
  context.lineWidth = 2;
  context.setLineDash([8, 8]);
  context.beginPath();
  context.moveTo(path[0].x, path[0].y);
  for (const point of path.slice(1)) {
    context.lineTo(point.x, point.y);
  }
  context.stroke();
  context.setLineDash([]);
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
  const node = resolveLocationPoint(layout, nodeLocation);
  if (!node) return null;
  return nearestSegmentEndpoint(layout, segmentLocation, node);
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
  context.fillStyle = color;
  context.font = "12px Segoe UI, system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, x, y);
}

function ionColor(id) {
  const palette = ["#57c7b8", "#f07178", "#c678dd", "#e5c07b", "#61afef", "#98c379", "#d5a84f"];
  return palette[Math.abs(id) % palette.length];
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
