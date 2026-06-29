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
  return String(Number(value || 0));
}

function programIdFromPath(path = "") {
  const normalized = String(path).replaceAll("\\", "/");
  const file = normalized.split("/").pop() || normalized;
  return file.replace(/\.[^.]+$/, "");
}

function labelFromId(id = "") {
  return id.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
