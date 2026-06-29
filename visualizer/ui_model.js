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
  if (isProgressMetrics(previousMetrics)) {
    const progress = headlineProgress(previousMetrics, current);
    return [
      {
        kind: "time",
        label: "Execution time",
        value: formatNumber(progress.elapsedTime),
        unit: "cycles",
        total: formatNumber(current.finishTime),
        detail: `${formatNumber(progress.elapsedTime)} / ${formatNumber(current.finishTime)} cycles elapsed`,
        subdetail: "live playback clock",
        progress: ratio(progress.elapsedTime, current.finishTime),
      },
      {
        kind: "motion",
        label: "Shuttling ops",
        value: formatNumber(progress.shuttlingOps),
        unit: "ops",
        total: formatNumber(current.shuttlingOps),
        detail: `${formatNumber(progress.shuttlingOps)} / ${formatNumber(
          current.shuttlingOps,
        )} ops started, ${formatNumber(progress.activeShuttlingOps)} active`,
        subdetail: `${formatNumber(progress.splitCount)} split, ${formatNumber(progress.moveCount)} move, ${formatNumber(
          progress.mergeCount,
        )} merge`,
        progress: ratio(progress.shuttlingOps, current.shuttlingOps),
      },
      {
        kind: "shuttle-time",
        label: "Shuttling time",
        value: formatNumber(progress.shuttlingTime),
        unit: "cycles",
        total: formatNumber(current.shuttlingTime),
        detail: `${formatNumber(progress.shuttlingTime)} / ${formatNumber(current.shuttlingTime)} shuttle cycles`,
        subdetail: "cumulative motion work",
        progress: ratio(progress.shuttlingTime, current.shuttlingTime),
      },
    ];
  }

  const previous = previousMetrics ? headlineMetrics(previousMetrics) : null;
  return [
    {
      label: "Execution time",
      value: formatNumber(current.finishTime),
      unit: "cycles",
      detail: "end-to-end schedule",
      delta: metricDelta(current.finishTime, previous?.finishTime),
    },
    {
      label: "Shuttling ops",
      value: formatNumber(current.shuttlingOps),
      unit: "ops",
      detail: `${formatNumber(current.splitCount)} split, ${formatNumber(current.moveCount)} move, ${formatNumber(
        current.mergeCount,
      )} merge`,
      delta: metricDelta(current.shuttlingOps, previous?.shuttlingOps),
    },
    {
      label: "Shuttling time",
      value: formatNumber(current.shuttlingTime),
      unit: "cycles",
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

function headlineMetrics(metrics = {}) {
  const counts = metrics.counts || {};
  const finishTime = Number(metrics.finish_time ?? metrics.finishTime ?? 0);
  const shuttlingTime = Number(metrics.shuttling_time ?? metrics.shuttlingTime ?? 0);
  const splitCount = Number(counts.split ?? metrics.split_count ?? metrics.splitCount ?? 0);
  const moveCount = Number(counts.move ?? metrics.move_count ?? metrics.moveCount ?? 0);
  const mergeCount = Number(counts.merge ?? metrics.merge_count ?? metrics.mergeCount ?? 0);
  return {
    finishTime,
    shuttlingTime,
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
