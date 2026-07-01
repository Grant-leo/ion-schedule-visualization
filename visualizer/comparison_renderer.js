export function renderComparisonRows(container, result) {
  container.replaceChildren();
  if (!result) {
    container.appendChild(emptyState("Generate at least two schedules to compare mapper or scheduler choices."));
    return;
  }
  if (result.status === "non_comparable") {
    container.appendChild(emptyState(`Not comparable: ${(result.reasons || []).join("; ")}`));
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const row of (result.rows || []).filter((item) => ["total_time", "shuttles", "fidelity", "channel_pressure"].includes(item.metric))) {
    const item = document.createElement("div");
    item.className = `comparison-row is-${row.winner}`;
    const label = document.createElement("span");
    label.className = "comparison-label";
    label.textContent = compactLabel(row.metric, row.label);
    const values = document.createElement("strong");
    values.className = "comparison-values";
    values.textContent = `${formatMetric(row.metric, row.baseline)} -> ${formatMetric(row.metric, row.candidate)}`;
    const delta = document.createElement("span");
    delta.className = "comparison-delta";
    delta.textContent = formatDelta(row.metric, row.delta, row.winner);
    item.append(label, values, delta);
    fragment.appendChild(item);
  }
  if (result.flags?.length) {
    const flags = document.createElement("div");
    flags.className = "comparison-flags";
    flags.textContent = result.flags.map(flagLabel).join(" | ");
    fragment.appendChild(flags);
  }
  container.appendChild(fragment);
}

export function runOptionLabel(record) {
  const run = record?.trace?.run || {};
  const program = run.program ? shortProgram(run.program) : "trace";
  const mapper = run.mapper || "unknown mapper";
  const scheduler = run.scheduler_policy || "unknown scheduler";
  return `${program} | ${run.machine || "architecture"} | ${mapper} | ${scheduler}`;
}

function emptyState(text) {
  const node = document.createElement("div");
  node.className = "comparison-empty";
  node.textContent = text;
  return node;
}

function formatMetric(metric, value) {
  if (metric === "fidelity") return `${(Number(value || 0) * 100).toFixed(2)}%`;
  return formatNumber(value);
}

function compactLabel(metric, fallback) {
  if (metric === "total_time") return "Time";
  if (metric === "channel_pressure") return "Channel";
  if (metric === "fidelity") return "Fidelity";
  return fallback;
}

function formatDelta(metric, delta, winner) {
  if (winner === "tie") return "tie";
  if (metric === "fidelity") {
    const sign = delta >= 0 ? "+" : "";
    return `${sign}${(delta * 100).toFixed(2)}%`;
  }
  const sign = delta >= 0 ? "+" : "";
  return `${sign}${formatNumber(delta)}`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(Number(value || 0));
}

function flagLabel(flag) {
  if (flag === "seed_mismatch") return "different seeds";
  if (flag === "tie_break_mismatch") return "different tie-breaks";
  return String(flag).replaceAll("_", " ");
}

function shortProgram(program) {
  return String(program).split(/[\\/]/).pop().replace(/\.qasm$/i, "");
}
