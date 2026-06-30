export function createMetricCards(metrics = {}) {
  const finishTime = Number(metrics.finish_time ?? metrics.finishTime ?? 0);
  const shuttlingTime = Number(metrics.shuttling_time ?? metrics.shuttlingTime ?? 0);
  const eventCount = Number(metrics.event_count ?? metrics.eventCount ?? 0);
  const counts = metrics.counts || {};
  const splitCount = Number(counts.split ?? metrics.split_count ?? metrics.splitCount ?? 0);
  const moveCount = Number(counts.move ?? metrics.move_count ?? metrics.moveCount ?? 0);
  const mergeCount = Number(counts.merge ?? metrics.merge_count ?? metrics.mergeCount ?? 0);
  const maxParallel = Number(metrics.max_parallel_gates ?? metrics.maxParallelGates ?? 0);
  const crossTrapParallel = Number(metrics.cross_trap_parallel_gates ?? metrics.crossTrapParallelGates ?? 0);
  const sameTrapOverlaps = Number(metrics.same_trap_gate_overlaps ?? metrics.sameTrapGateOverlaps ?? 0);
  const swapCount = Number(metrics.swap_count ?? metrics.swapCount ?? 0);
  const swapHops = Number(metrics.swap_hops ?? metrics.swapHops ?? 0);
  const ionHops = Number(metrics.ion_hops ?? metrics.ionHops ?? 0);
  const blockedOps = Number(metrics.blocked_ops ?? metrics.blockedOps ?? 0);
  const readyOps = Number(metrics.ready_ops ?? metrics.readyOps ?? 0);
  const ratio = finishTime > 0 ? (shuttlingTime / finishTime) * 100 : 0;
  return [
    {
      label: "Finish time",
      value: formatNumber(finishTime),
      detail: `${formatNumber(eventCount)} scheduled events`,
    },
    {
      label: "Parallel gates",
      value: formatNumber(maxParallel),
      detail: `${formatNumber(crossTrapParallel)} cross-trap overlaps, ${formatNumber(sameTrapOverlaps)} same-trap`,
    },
    {
      label: "Gate mix",
      value: `${metrics.one_qubit_gates ?? 0} / ${metrics.two_qubit_gates ?? 0}`,
      detail: "1Q / 2Q gates preserved",
    },
    {
      label: "Motion ops",
      value: `${formatNumber(splitCount)} / ${formatNumber(moveCount)} / ${formatNumber(mergeCount)}`,
      detail: `split / move / merge, ${ratio.toFixed(1)}% shuttle time`,
    },
    {
      label: "Swap work",
      value: formatNumber(swapCount),
      detail: `${formatNumber(swapHops)} swap hops, ${formatNumber(ionHops)} ion hops`,
    },
    {
      label: "DAG pressure",
      value: formatNumber(blockedOps),
      detail: `blocked DAG ops, ${formatNumber(readyOps)} ready`,
    },
  ];
}

export function createHeadlineMetricCards(metrics = {}, previousMetrics = null) {
  const current = headlineMetrics(metrics);
  const scaleBadge = (metrics.playback_scale_label || playbackScaleSummary(current.playback_speed, current).label).replace(
    "Time magnification ",
    "",
  );
  if (isProgressMetrics(previousMetrics)) {
    const progress = headlineProgress(previousMetrics, current);
    return [
      {
        kind: "time",
        label: "Total time",
        value: formatMicrosecondValue(toMicroseconds(progress.elapsedTime, current)),
        unit: `/ ${formatMicroseconds(current.finishTime, current)}`,
        badge: scaleBadge,
        total: formatNumber(current.finishTime),
        detail: `${scaleBadge} demo magnification`,
        deltaPulse: metrics.latest_time_delta
          ? { text: metrics.latest_time_delta, key: metrics.latest_time_delta_key || metrics.latest_time_delta }
          : null,
        progress: ratio(progress.elapsedTime, current.finishTime),
      },
      {
        kind: "motion",
        label: "Shuttles",
        value: formatNumber(progress.shuttlingOps),
        unit: `/ ${formatNumber(current.shuttlingOps)} ops`,
        total: formatNumber(current.shuttlingOps),
        detail: `${formatNumber(progress.activeShuttlingOps)} active now`,
        subdetail: `${formatNumber(progress.splitCount)} split | ${formatNumber(progress.moveCount)} move | ${formatNumber(
          progress.mergeCount,
        )} merge`,
        progress: ratio(progress.shuttlingOps, current.shuttlingOps),
      },
      {
        kind: "shuttle-time",
        label: "Shuttle time",
        value: formatMicrosecondValue(toMicroseconds(progress.shuttlingTime, current)),
        unit: `/ ${formatMicroseconds(current.shuttlingTime, current)}`,
        total: formatNumber(current.shuttlingTime),
        detail: "cumulative shuttling work",
        progress: ratio(progress.shuttlingTime, current.shuttlingTime),
      },
    ];
  }

  const previous = previousMetrics ? headlineMetrics(previousMetrics) : null;
  return [
    {
      label: "Total time",
      value: formatMicrosecondValue(toMicroseconds(current.finishTime, current)),
      unit: "μs",
      detail: "end-to-end schedule",
      delta: metricDelta(current.finishTime, previous?.finishTime),
    },
    {
      label: "Shuttles",
      value: formatNumber(current.shuttlingOps),
      unit: "ops",
      detail: `${formatNumber(current.splitCount)} split | ${formatNumber(current.moveCount)} move | ${formatNumber(
        current.mergeCount,
      )} merge`,
      delta: metricDelta(current.shuttlingOps, previous?.shuttlingOps),
    },
    {
      label: "Shuttle time",
      value: formatMicrosecondValue(toMicroseconds(current.shuttlingTime, current)),
      unit: "μs",
      detail: `${current.shuttlingRatio.toFixed(1)}% of schedule`,
      delta: metricDelta(current.shuttlingTime, previous?.shuttlingTime),
    },
  ];
}

export function createScenarioCopy({ run = {}, program = null } = {}) {
  const programId = programIdFromPath(run.program);
  const programLabel = program?.label || labelFromId(programId) || "QCCD schedule";
  const machine = run.machine || "selected architecture";
  const mapper = run.mapper ? `${run.mapper} mapping` : "selected mapping";
  const scheduler = run.scheduler_policy ? `${run.scheduler_policy} scheduling` : "selected scheduling";
  return {
    title: `${programLabel} on ${machine}`,
    description: `Replay a QCCDSim trace with ${mapper}, ${scheduler}, ion shuttling, laser gates, and DAG progress.`,
  };
}

export function createValidationSummary(validation = {}) {
  const errors = Array.isArray(validation.errors) ? validation.errors.filter(Boolean) : [];
  if (validation.valid !== false && errors.length === 0) {
    return {
      state: "valid",
      title: "Schedule verified",
      detail: "Trace passes topology, dependency, capacity, resource, and endpoint checks.",
      errors: [],
    };
  }

  const visibleErrors = errors.slice(0, 3);
  const overflow = errors.length > visibleErrors.length ? `; +${errors.length - visibleErrors.length} more` : "";
  const detail = visibleErrors.length > 0 ? `${visibleErrors.join("; ")}${overflow}` : "Trace validation failed.";
  return {
    state: "blocked",
    title: "Schedule blocked",
    detail,
    errors,
  };
}

export function traceCycleTimeUs(source = {}) {
  const value = Number(source?.timing?.cycle_time_us ?? source?.cycle_time_us ?? source?.run?.cycle_time_us ?? 1);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

export function displayUsPerMs(source = {}) {
  const value = Number(source?.timing?.display_us_per_ms ?? source?.display_us_per_ms ?? 1);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

export function playbackDeltaCycles(deltaMs, speedMultiplier = 1, timingSource = {}) {
  const speed = Number(speedMultiplier);
  const effectiveSpeed = Number.isFinite(speed) && speed > 0 ? speed : 1;
  const hardwareUs = Math.max(0, Number(deltaMs) || 0) * effectiveSpeed * displayUsPerMs(timingSource);
  return hardwareUs / traceCycleTimeUs(timingSource);
}

export function playbackScaleSummary(speedMultiplier = 1, timingSource = {}) {
  const speed = Number(speedMultiplier);
  const effectiveSpeed = Number.isFinite(speed) && speed > 0 ? speed : 1;
  const hardwareUsPerDisplayMs = effectiveSpeed * displayUsPerMs(timingSource);
  const magnification = hardwareUsPerDisplayMs > 0 ? 1000 / hardwareUsPerDisplayMs : 1;
  return {
    label: `Time magnification ${formatScale(magnification)}`,
    detail: `1 ms display = ${formatMicrosecondValue(hardwareUsPerDisplayMs)} μs hardware`,
    magnification,
  };
}

export function formatMicroseconds(cycles, timingSource = {}, { signed = false } = {}) {
  const value = toMicroseconds(cycles, timingSource);
  const prefix = signed && value >= 0 ? "+" : "";
  return `${prefix}${formatMicrosecondValue(value)} μs`;
}

export function eventDurationMicroseconds(event = {}, timingSource = {}) {
  const duration = Math.max(0, Number(event.end ?? 0) - Number(event.start ?? 0));
  return formatMicroseconds(duration, timingSource, { signed: true });
}

export function describeEvent(event) {
  if (!event) return "No active hardware operation";
  const duration = Math.max(0, Number(event.end ?? 0) - Number(event.start ?? 0));
  const ions = (event.ions || []).join(", ");
  if (event.type === "gate") {
    const gate = String(event.metadata?.gate_name || "gate").toUpperCase();
    return `Apply ${gate} gate on ions ${ions} in ${formatLocation(event.target)} - ${duration} cycles`;
  }
  if (event.type === "split") {
    const swapIons = event.metadata?.swap_ions || [];
    if (Number(event.metadata?.swap_count || 0) > 0 && swapIons.length === 2) {
      return `Swap ions ${swapIons.join(" and ")} inside ${formatLocation(
        event.source,
      )}, then split ion ${ions} via ${formatEndpoint(event.metadata?.endpoint)} endpoint - ${duration} cycles`;
    }
    return `Split ion ${ions} from ${formatLocation(event.source)} into channel ${formatLocation(
      event.target,
    )} via ${formatEndpoint(event.metadata?.endpoint)} endpoint - ${duration} cycles`;
  }
  if (event.type === "move") {
    return `Shuttle ion ${ions} from ${formatLocation(event.source)} to ${formatLocation(
      event.target,
    )} - ${duration} cycles`;
  }
  if (event.type === "merge") {
    return `Merge ion ${ions} from channel ${formatLocation(event.source)} into ${formatLocation(
      event.target,
    )} via ${formatEndpoint(event.metadata?.endpoint)} endpoint - ${duration} cycles`;
  }
  return `${event.type || "Operation"} on ions ${ions} - ${duration} cycles`;
}

export function summarizeDag(dagState = {}) {
  const summary = {
    total: 0,
    completed: 0,
    active: 0,
    ready: 0,
    blocked: 0,
    edges: (dagState.edges || []).length,
  };
  for (const node of dagState.nodes?.values?.() || []) {
    summary.total += 1;
    const state = node.state || "blocked";
    summary[state] = (summary[state] || 0) + 1;
  }
  return summary;
}

export function formatLocation(location = "") {
  const [kind, id] = String(location).split(":");
  if (kind === "trap") return `T${id}`;
  if (kind === "segment") return `S${id}`;
  if (kind === "junction") return `J${id}`;
  return location || "unknown";
}

function formatEndpoint(endpoint) {
  if (endpoint === "L") return "left";
  if (endpoint === "R") return "right";
  return "trap";
}

function formatNumber(value) {
  return String(Math.floor(Number(value || 0)));
}

function toMicroseconds(cycles, timingSource = {}) {
  return Number(cycles || 0) * traceCycleTimeUs(timingSource);
}

function formatMicrosecondValue(value) {
  const numeric = Number(value || 0);
  if (Math.abs(numeric) >= 100 || Number.isInteger(numeric)) {
    return String(Math.round(numeric));
  }
  return numeric.toFixed(Math.abs(numeric) >= 10 ? 1 : 2).replace(/\.?0+$/, "");
}

function formatScale(value) {
  const numeric = Number(value || 0);
  if (numeric >= 100 || Number.isInteger(numeric)) return `${Math.round(numeric)}x`;
  return `${numeric.toFixed(numeric >= 10 ? 1 : 2).replace(/\.?0+$/, "")}x`;
}

function headlineMetrics(metrics = {}) {
  const counts = metrics.counts || {};
  const finishTime = Number(metrics.finish_time ?? metrics.finishTime ?? 0);
  const shuttlingTime = Number(metrics.shuttling_time ?? metrics.shuttlingTime ?? 0);
  const cycleTimeUs = traceCycleTimeUs(metrics);
  const displayUs = displayUsPerMs(metrics);
  const playbackSpeed = Number(metrics.playback_speed ?? metrics.playbackSpeed ?? 1);
  const splitCount = Number(counts.split ?? metrics.split_count ?? metrics.splitCount ?? 0);
  const moveCount = Number(counts.move ?? metrics.move_count ?? metrics.moveCount ?? 0);
  const mergeCount = Number(counts.merge ?? metrics.merge_count ?? metrics.mergeCount ?? 0);
  return {
    finishTime,
    shuttlingTime,
    cycle_time_us: cycleTimeUs,
    display_us_per_ms: displayUs,
    playback_speed: Number.isFinite(playbackSpeed) && playbackSpeed > 0 ? playbackSpeed : 1,
    splitCount,
    moveCount,
    mergeCount,
    shuttlingOps: splitCount + moveCount + mergeCount,
    shuttlingRatio: finishTime > 0 ? (shuttlingTime / finishTime) * 100 : 0,
  };
}

function isProgressMetrics(metrics) {
  return Boolean(metrics && (Object.hasOwn(metrics, "elapsedTime") || Object.hasOwn(metrics, "activeShuttlingOps")));
}

function headlineProgress(metrics = {}, totals = {}) {
  const counts = metrics.counts || {};
  const splitCount = Number(counts.split ?? metrics.split_count ?? metrics.splitCount ?? 0);
  const moveCount = Number(counts.move ?? metrics.move_count ?? metrics.moveCount ?? 0);
  const mergeCount = Number(counts.merge ?? metrics.merge_count ?? metrics.mergeCount ?? 0);
  const elapsedTime = Number(metrics.elapsedTime ?? metrics.elapsed_time ?? metrics.finishTime ?? 0);
  const shuttlingTime = Number(metrics.shuttling_time ?? metrics.shuttlingTime ?? 0);
  return {
    elapsedTime,
    shuttlingTime,
    splitCount,
    moveCount,
    mergeCount,
    shuttlingOps: Number(metrics.shuttlingOps ?? splitCount + moveCount + mergeCount),
    activeShuttlingOps: Number(metrics.activeShuttlingOps ?? metrics.active_shuttling_ops ?? 0),
    finishTime: Number(metrics.finish_time ?? metrics.finishTime ?? totals.finishTime ?? 0),
    cycle_time_us: traceCycleTimeUs(metrics.cycle_time_us ? metrics : totals),
  };
}

function ratio(current, total) {
  const denominator = Number(total || 0);
  if (denominator <= 0) return 0;
  return Math.min(1, Math.max(0, Number(current || 0) / denominator));
}

function metricDelta(current, previous) {
  if (previous === undefined || previous === null || Number.isNaN(previous)) {
    return { text: "baseline", tone: "neutral" };
  }
  const delta = Number(current || 0) - Number(previous || 0);
  const text = delta > 0 ? `+${formatNumber(delta)}` : formatNumber(delta);
  if (delta < 0) return { text, tone: "good" };
  if (delta > 0) return { text, tone: "bad" };
  return { text, tone: "neutral" };
}

function programIdFromPath(path = "") {
  const normalized = String(path).replaceAll("\\", "/");
  const file = normalized.split("/").pop() || normalized;
  return file.replace(/\.[^.]+$/, "");
}

function labelFromId(id = "") {
  return id.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
