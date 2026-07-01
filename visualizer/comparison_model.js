const LOWER_IS_BETTER = "lower";
const HIGHER_IS_BETTER = "higher";

const METRIC_DEFINITIONS = [
  ["total_time", "Total time", LOWER_IS_BETTER],
  ["shuttles", "Shuttles", LOWER_IS_BETTER],
  ["split_count", "Splits", LOWER_IS_BETTER],
  ["move_count", "Moves", LOWER_IS_BETTER],
  ["merge_count", "Merges", LOWER_IS_BETTER],
  ["swap_count", "Swaps", LOWER_IS_BETTER],
  ["ion_travel", "Ion travel proxy", LOWER_IS_BETTER],
  ["channel_pressure", "Channel pressure", LOWER_IS_BETTER],
  ["dag_stall_time", "DAG stall time", LOWER_IS_BETTER],
  ["fidelity", "Estimated fidelity", HIGHER_IS_BETTER],
];

export function createComparisonRows(traces = []) {
  if (!Array.isArray(traces) || traces.length < 2) return [];
  return compareTracePair(traces[0], traces[1]).rows;
}

export function compareTracePair(baseline, candidate) {
  const compatibility = compatibilityReport(baseline, candidate);
  if (compatibility.reasons.length > 0) {
    return {
      valid: false,
      status: "non_comparable",
      reasons: compatibility.reasons,
      flags: compatibility.flags,
      compatibility,
      rows: [],
    };
  }

  const baselineMetrics = comparisonMetrics(baseline);
  const candidateMetrics = comparisonMetrics(candidate);
  return {
    valid: true,
    status: "comparable",
    reasons: [],
    flags: compatibility.flags,
    compatibility,
    baseline: runSummary(baseline),
    candidate: runSummary(candidate),
    rows: METRIC_DEFINITIONS.map(([metric, label, direction]) =>
      metricRow(metric, label, direction, baselineMetrics[metric], candidateMetrics[metric]),
    ),
  };
}

function compatibilityReport(baseline, candidate) {
  const reasons = [];
  const flags = [];
  appendValidationReasons(reasons, "baseline", baseline);
  appendValidationReasons(reasons, "candidate", candidate);

  const baselineCircuit = circuitHash(baseline);
  const candidateCircuit = circuitHash(candidate);
  if (baselineCircuit !== candidateCircuit) reasons.push("circuit DAG differs");

  const baselineArchitecture = architectureHash(baseline);
  const candidateArchitecture = architectureHash(candidate);
  if (baselineArchitecture !== candidateArchitecture) reasons.push("architecture differs");

  const baselineTiming = modelHash(baseline, "timing_model");
  const candidateTiming = modelHash(candidate, "timing_model");
  if (baselineTiming && candidateTiming && baselineTiming !== candidateTiming) reasons.push("timing model differs");

  const baselineMetric = modelHash(baseline, "metric_model");
  const candidateMetric = modelHash(candidate, "metric_model");
  if (baselineMetric && candidateMetric && baselineMetric !== candidateMetric) reasons.push("metric model differs");

  if (runValue(baseline, "seed") !== runValue(candidate, "seed")) flags.push("seed_mismatch");
  if (runValue(baseline, "tie_break_policy") !== runValue(candidate, "tie_break_policy")) {
    flags.push("tie_break_mismatch");
  }

  return {
    circuit_hash: baselineCircuit === candidateCircuit ? baselineCircuit : null,
    baseline_circuit_hash: baselineCircuit,
    candidate_circuit_hash: candidateCircuit,
    architecture_hash: baselineArchitecture === candidateArchitecture ? baselineArchitecture : null,
    baseline_architecture_hash: baselineArchitecture,
    candidate_architecture_hash: candidateArchitecture,
    timing_model_hash: baselineTiming === candidateTiming ? baselineTiming : null,
    metric_model_hash: baselineMetric === candidateMetric ? baselineMetric : null,
    reasons,
    flags,
  };
}

function comparisonMetrics(trace = {}) {
  const exportedMetrics = trace.metrics || {};
  const metrics = recomputeMetrics(trace);
  if (exportedMetrics.fidelity !== undefined) metrics.fidelity = exportedMetrics.fidelity;
  const counts = metrics.counts || {};
  const splitCount = number(counts.split);
  const moveCount = number(counts.move);
  const mergeCount = number(counts.merge);
  return {
    total_time: number(metrics.finish_time),
    shuttles: splitCount + moveCount + mergeCount,
    split_count: splitCount,
    move_count: moveCount,
    merge_count: mergeCount,
    swap_count: number(metrics.swap_count),
    ion_travel: number(metrics.ion_hops),
    channel_pressure: channelPressure(trace),
    dag_stall_time: dagStallTime(trace),
    fidelity: fidelity(trace),
  };
}

function metricRow(metric, label, direction, baseline, candidate) {
  const delta = candidate - baseline;
  let winner = "tie";
  if (Math.abs(delta) > 1e-12) {
    winner = direction === LOWER_IS_BETTER ? (delta < 0 ? "candidate" : "baseline") : delta > 0 ? "candidate" : "baseline";
  }
  return {
    metric,
    label,
    direction,
    baseline,
    candidate,
    delta,
    delta_percent: baseline === 0 ? null : delta / baseline,
    winner,
  };
}

function channelPressure(trace = {}) {
  const events = (trace.events || []).filter((event) => ["split", "move", "merge"].includes(event.type));
  return events.reduce((total, event) => {
    const duration = Math.max(0, number(event.end) - number(event.start));
    return total + duration * eventSegmentResources(event).length;
  }, 0);
}

function eventSegmentResources(event) {
  if (event.type === "split" && isSegment(event.target)) return [event.target];
  if (event.type === "merge" && isSegment(event.source)) return [event.source];
  if (event.type === "move") return [...new Set([event.source, event.target].filter(isSegment))].sort();
  return [];
}

function dagStallTime(trace = {}) {
  const gateWindows = new Map();
  for (const event of trace.events || []) {
    if (event.type !== "gate") continue;
    const gateId = event.metadata?.gate_id;
    if (gateId !== undefined && gateId !== null) gateWindows.set(Number(gateId), [number(event.start), number(event.end)]);
  }

  let totalWait = 0;
  for (const edge of trace.dag?.edges || []) {
    const source = gateWindows.get(Number(edge.source));
    const target = gateWindows.get(Number(edge.target));
    if (!source || !target) continue;
    totalWait += Math.max(0, target[0] - source[1]);
  }
  return totalWait;
}

function fidelity(trace = {}) {
  const metricsFidelity = boundedFidelity(trace.metrics?.fidelity);
  if (metricsFidelity !== null) return metricsFidelity;
  return (trace.events || []).reduce((product, event) => product * eventFidelityFactor(event, trace), 1);
}

function eventFidelityFactor(event, trace = {}) {
  const metadataFidelity = boundedFidelity(event.metadata?.fidelity);
  if (metadataFidelity !== null) return metadataFidelity;
  const run = trace.run || {};
  if (event.type === "gate") {
    const arity = number(event.metadata?.arity ?? event.ions?.length ?? 1, 1);
    const base = boundedFidelity(arity === 1 ? run.single_qubit_gate_fidelity : run.two_qubit_gate_fidelity) ?? (arity === 1 ? 0.999 : 0.992);
    const durationPenalty = Math.max(0, number(event.end) - number(event.start)) / 1_000_000;
    return Math.max(0.0001, base - durationPenalty);
  }
  if (event.type === "split") {
    const swapCount = number(event.metadata?.swap_count);
    if (swapCount > 0) return (boundedFidelity(run.two_qubit_gate_fidelity) ?? 1) ** (swapCount * 3);
    return boundedFidelity(run.split_fidelity ?? run.shuttle_fidelity) ?? 1;
  }
  if (event.type === "move") return boundedFidelity(run.move_fidelity ?? run.shuttle_fidelity) ?? 1;
  if (event.type === "merge") return boundedFidelity(run.merge_fidelity ?? run.shuttle_fidelity) ?? 1;
  return 1;
}

function circuitHash(trace = {}) {
  const dag = trace.dag || {};
  return stableHash({
    nodes: (dag.nodes || [])
      .map((node) => ({
        id: node.id,
        gate_name: node.gate_name,
        qubits: node.qubits || [],
        arity: node.arity,
      }))
      .sort((a, b) => Number(a.id) - Number(b.id)),
    edges: (dag.edges || [])
      .map((edge) => ({ source: edge.source, target: edge.target }))
      .sort((a, b) => Number(a.source) - Number(b.source) || Number(a.target) - Number(b.target)),
  });
}

function stableHash(value) {
  const text = stableStringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function modelHash(trace = {}, key) {
  const model = trace[key];
  return model && typeof model === "object" ? model.hash : null;
}

function architectureHash(trace = {}) {
  if (typeof trace.architecture_hash === "string" && trace.architecture_hash) return trace.architecture_hash;
  return stableHash({
    machine: runValue(trace, "machine"),
    topology: trace.topology || {},
  });
}

function runSummary(trace = {}) {
  const run = trace.run || {};
  return {
    id: run.id,
    program: run.program,
    machine: run.machine,
    mapper: run.mapper,
    scheduler_policy: run.scheduler_policy,
  };
}

function runValue(trace = {}, key) {
  return trace.run?.[key];
}

function appendValidationReasons(reasons, label, trace = {}) {
  if (!trace.validation || typeof trace.validation !== "object") {
    reasons.push(`${label} validation missing`);
    return;
  }
  if (trace.validation.valid === true) return;
  const errors = Array.isArray(trace.validation.errors) ? trace.validation.errors.slice(0, 3).join("; ") : "";
  reasons.push(`${label} validation failed${errors ? `: ${errors}` : ""}`);
}

function isSegment(location) {
  return typeof location === "string" && location.startsWith("segment:");
}

function boundedFidelity(value) {
  const numeric = optionalNumber(value);
  if (numeric === null) return null;
  return Math.min(1, Math.max(0.0001, numeric));
}

function optionalNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function number(value, fallback = 0) {
  return optionalNumber(value) ?? fallback;
}

function recomputeMetrics(trace = {}) {
  const events = (trace.events || []).filter((event) => event && typeof event === "object");
  const counts = { gate: 0, split: 0, move: 0, merge: 0 };
  const times = { gate: 0, split: 0, move: 0, merge: 0 };
  let oneQubitGates = 0;
  let twoQubitGates = 0;
  let swapCount = 0;
  let swapHops = 0;
  let ionHops = 0;
  for (const event of events) {
    if (!Object.hasOwn(counts, event.type)) continue;
    const duration = number(event.end) - number(event.start);
    counts[event.type] += 1;
    times[event.type] += duration;
    const metadata = event.metadata || {};
    if (event.type === "gate") {
      const arity = number(metadata.arity ?? event.ions?.length ?? 1, 1);
      if (arity === 1) oneQubitGates += 1;
      else twoQubitGates += 1;
    } else if (event.type === "split") {
      swapCount += number(metadata.swap_count);
      swapHops += number(metadata.swap_hops);
      ionHops += number(metadata.ion_hops);
    }
  }
  return {
    event_count: events.length,
    finish_time: Math.max(...events.map((event) => number(event.end)), 0),
    counts,
    times,
    one_qubit_gates: oneQubitGates,
    two_qubit_gates: twoQubitGates,
    shuttling_time: times.split + times.move + times.merge,
    swap_count: swapCount,
    swap_hops: swapHops,
    ion_hops: ionHops,
  };
}
