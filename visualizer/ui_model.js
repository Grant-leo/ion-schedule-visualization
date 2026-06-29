export function createMetricCards(metrics = {}) {
  const finishTime = Number(metrics.finish_time ?? metrics.finishTime ?? 0);
  const shuttlingTime = Number(metrics.shuttling_time ?? metrics.shuttlingTime ?? 0);
  const ratio = finishTime > 0 ? (shuttlingTime / finishTime) * 100 : 0;
  return [
    {
      label: "Finish time",
      value: formatNumber(finishTime),
      detail: "cycles in the scheduled trace",
    },
    {
      label: "Schedule events",
      value: formatNumber(metrics.event_count ?? metrics.eventCount ?? 0),
      detail: "gate + split/move/merge operations",
    },
    {
      label: "Gate mix",
      value: `${metrics.one_qubit_gates ?? 0} / ${metrics.two_qubit_gates ?? 0}`,
      detail: "1Q / 2Q gates preserved",
    },
    {
      label: "Shuttling burden",
      value: formatNumber(shuttlingTime),
      detail: `aggregate cycles, ${ratio.toFixed(1)}% of makespan`,
    },
  ];
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
