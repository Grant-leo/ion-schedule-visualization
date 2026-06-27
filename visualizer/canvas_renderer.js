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
  const marginX = Math.max(72, width * 0.07);
  const traps = new Map();
  const junctions = new Map();
  const segments = new Map();
  const segmentEndpoints = new Map();

  const trapCount = Math.max(1, trace.topology.traps.length);
  for (const [index, trap] of trace.topology.traps.entries()) {
    const x =
      trapCount === 1
        ? width / 2
        : marginX + (index * (width - marginX * 2)) / Math.max(1, trapCount - 1);
    traps.set(`trap:${trap.id}`, { x, y: height * 0.58 });
  }

  const junctionCount = Math.max(1, trace.topology.junctions.length);
  for (const [index, junction] of trace.topology.junctions.entries()) {
    const x =
      junctionCount === 1
        ? width / 2
        : marginX + (index * (width - marginX * 2)) / Math.max(1, junctionCount - 1);
    junctions.set(`junction:${junction.id}`, { x, y: height * 0.34 });
  }

  for (const segment of trace.topology.segments) {
    const start = resolveNodePoint(traps, junctions, segment.from);
    const end = resolveNodePoint(traps, junctions, segment.to);
    if (!start || !end) continue;
    const key = `segment:${segment.id}`;
    segments.set(key, interpolatePoint(start, end, 0.5));
    segmentEndpoints.set(key, { start, end });
  }

  return { traps, junctions, segments, segmentEndpoints };
}

function resolveNodePoint(traps, junctions, location) {
  return traps.get(location) || junctions.get(location) || null;
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
    context.fillStyle = cssColor("--color-trap");
    context.strokeStyle = "rgba(238, 242, 247, 0.28)";
    context.lineWidth = 1;
    roundedRect(context, point.x - 30, point.y - 18, 60, 36, 6);
    context.fill();
    context.stroke();
    drawLabel(context, `T${trap.id}`, point.x, point.y + 4, cssColor("--color-text"));
  }
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
      const start = resolveLocationPoint(layout, event.source);
      const end = resolveLocationPoint(layout, event.target);
      if (!start || !end) continue;
      const point = interpolatePoint(start, end, eventProgress(event, state.time));
      context.strokeStyle = cssColor("--color-move");
      context.lineWidth = 2;
      context.beginPath();
      context.arc(point.x, point.y, 24, 0, Math.PI * 2);
      context.stroke();
      continue;
    }

    const point = resolveLocationPoint(layout, event.target);
    if (!point) continue;
    context.strokeStyle = cssColor("--color-gate");
    context.lineWidth = 4;
    context.beginPath();
    context.arc(point.x, point.y, 34, 0, Math.PI * 2);
    context.stroke();
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
      : resolveLocationPoint(layout, location);

    if (!basePoint) continue;
    const offsetKey = activeMotion ? `active:${activeMotion.id}` : location;
    const offsetIndex = offsets.get(offsetKey) || 0;
    offsets.set(offsetKey, offsetIndex + 1);
    const point = offsetPoint(basePoint, offsetIndex);

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
  const start = resolveLocationPoint(layout, event.source);
  const end = resolveLocationPoint(layout, event.target);
  if (!start || !end) return start || end;
  return interpolatePoint(start, end, eventProgress(event, time));
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
