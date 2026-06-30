const DEFAULT_OPTIONS = Object.freeze({
  maxWidth: 720,
  qubitCount: 0,
});

export function layoutCircuit(dagState = {}, options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const gates = [...(dagState.nodes?.values?.() || [])].sort((left, right) => left.id - right.id);
  const maxQubit = Math.max(
    Number(config.qubitCount || 0) - 1,
    ...gates.flatMap((gate) => gate.qubits || []).map((qubit) => Number(qubit)),
    0,
  );
  const qubits = Array.from({ length: maxQubit + 1 }, (_, index) => index);
  const rowGap = qubits.length > 32 ? 24 : qubits.length > 16 ? 26 : 30;
  const columnWidth = gates.length > 120 ? 32 : 42;
  const left = 46;
  const top = 24;
  const width = Math.max(Number(config.maxWidth || 0), left + gates.length * columnWidth + 42);
  const height = Math.max(72, top * 2 + (qubits.length - 1) * rowGap);
  const yByQubit = new Map(qubits.map((qubit, index) => [qubit, top + index * rowGap]));
  const gateLayout = gates.map((gate, index) => {
    const qubitList = (gate.qubits || []).map((qubit) => Number(qubit));
    const ys = qubitList.map((qubit) => yByQubit.get(qubit)).filter((value) => value !== undefined);
    return {
      ...gate,
      column: index,
      x: left + index * columnWidth + columnWidth / 2,
      y: ys.length ? ys[0] : top,
      qubits: qubitList,
      kind: gateKind(gate),
      state: gate.state || "blocked",
      minY: ys.length ? Math.min(...ys) : top,
      maxY: ys.length ? Math.max(...ys) : top,
    };
  });

  return {
    qubits,
    gates: gateLayout,
    yByQubit,
    width,
    height,
    left,
    top,
    rowGap,
    columnWidth,
  };
}

export function renderCircuitSvg(container, dagState = {}, options = {}) {
  if (!container) return null;
  const layout = layoutCircuit(dagState, {
    maxWidth: container.clientWidth || options.maxWidth || DEFAULT_OPTIONS.maxWidth,
    ...options,
  });
  const markup = circuitSvgMarkup(layout);
  if ("innerHTML" in container) {
    container.innerHTML = markup;
    focusActiveCircuitGate(container, layout);
  } else if (typeof container.replaceChildren === "function") {
    container.replaceChildren(markup);
  }
  return layout;
}

function circuitSvgMarkup(layout) {
  const wireStart = layout.left - 18;
  const wireEnd = layout.width - 18;
  const focusGate = activeFocusGate(layout);
  const wires = layout.qubits
    .map((qubit) => {
      const y = layout.yByQubit.get(qubit);
      return [
        `<text class="circuit-qubit-label" x="8" y="${y + 3}">q_${qubit}</text>`,
        `<line class="circuit-wire" x1="${wireStart}" y1="${y}" x2="${wireEnd}" y2="${y}" />`,
      ].join("");
    })
    .join("");
  const focus = focusGate ? focusMarkup(layout, focusGate) : "";
  const gates = layout.gates.map((gate) => gateMarkup(gate)).join("");
  const activeGateAttr = focusGate ? ` data-active-gate="${escapeAttr(focusGate.id)}"` : "";
  return [
    `<svg class="circuit-svg" data-node-count="${layout.gates.length}"${activeGateAttr} viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" role="img" aria-label="TikZ-style quantum circuit">`,
    focus,
    wires,
    gates,
    "</svg>",
  ].join("");
}

function activeFocusGate(layout) {
  return layout.gates.find((gate) => gate.state === "active") || layout.gates.find((gate) => gate.state === "ready") || null;
}

function focusMarkup(layout, gate) {
  const bandWidth = Math.max(18, layout.columnWidth * 0.72);
  const label = `${gateLabel(gate)} ${gate.qubits.map((qubit) => `q${qubit}`).join(",")}`;
  const labelX = Math.min(Math.max(gate.x, layout.left + 44), layout.width - 58);
  const labelWidth = Math.max(54, Math.min(108, label.length * 7 + 18));
  return [
    `<rect class="circuit-focus-band" x="${gate.x - bandWidth / 2}" y="6" width="${bandWidth}" height="${Math.max(18, layout.height - 12)}" rx="5" />`,
    `<g class="circuit-active-label" aria-hidden="true">`,
    `<rect x="${labelX - labelWidth / 2}" y="5" width="${labelWidth}" height="17" rx="4" />`,
    `<text x="${labelX}" y="17">${escapeText(label)}</text>`,
    "</g>",
  ].join("");
}

function gateMarkup(gate) {
  if (gate.kind === "cx" && gate.qubits.length >= 2) {
    const [controlY, targetY] = [gate.minY, gate.maxY];
    return [
      `<g class="circuit-gate ${escapeAttr(gate.state)} cx" data-gate-id="${gate.id}">`,
      `<line class="circuit-cx-line" x1="${gate.x}" y1="${controlY}" x2="${gate.x}" y2="${targetY}" />`,
      `<circle class="circuit-control" cx="${gate.x}" cy="${controlY}" r="4" />`,
      `<circle class="circuit-target" cx="${gate.x}" cy="${targetY}" r="8" />`,
      `<line class="circuit-target-plus" x1="${gate.x - 6}" y1="${targetY}" x2="${gate.x + 6}" y2="${targetY}" />`,
      `<line class="circuit-target-plus" x1="${gate.x}" y1="${targetY - 6}" x2="${gate.x}" y2="${targetY + 6}" />`,
      "</g>",
    ].join("");
  }

  if (gate.qubits.length > 1) {
    const height = Math.max(20, gate.maxY - gate.minY + 18);
    const y = gate.minY - 9;
    return [
      `<g class="circuit-gate ${escapeAttr(gate.state)} multi" data-gate-id="${gate.id}">`,
      `<rect x="${gate.x - 13}" y="${y}" width="26" height="${height}" rx="3" />`,
      `<text x="${gate.x}" y="${gate.minY + height / 2 - 6}">${gateLabel(gate)}</text>`,
      "</g>",
    ].join("");
  }

  return [
    `<g class="circuit-gate ${escapeAttr(gate.state)} oneq" data-gate-id="${gate.id}">`,
    `<rect x="${gate.x - 13}" y="${gate.y - 10}" width="26" height="20" rx="3" />`,
    `<text x="${gate.x}" y="${gate.y + 4}">${gateLabel(gate)}</text>`,
    "</g>",
  ].join("");
}

function gateKind(gate) {
  const name = String(gate.gate_name || gate.name || "").toLowerCase();
  if ((name === "cx" || name === "cnot") && (gate.qubits || []).length >= 2) return "cx";
  return (gate.qubits || []).length > 1 ? "multi" : "oneq";
}

function gateLabel(gate) {
  return escapeText(String(gate.gate_name || gate.name || "G").toUpperCase().slice(0, 4));
}

function focusActiveCircuitGate(container, layout) {
  const active = layout.gates.find((gate) => gate.state === "active") || layout.gates.find((gate) => gate.state === "ready");
  if (!active || !Number.isFinite(container.clientWidth)) return;
  const nextScrollLeft = Math.max(0, active.x - container.clientWidth * 0.45);
  if (Math.abs((container.scrollLeft || 0) - nextScrollLeft) > 18) {
    container.scrollLeft = nextScrollLeft;
  }
  const nextScrollTop = Math.max(0, active.minY - (container.clientHeight || 0) * 0.38);
  if (Math.abs((container.scrollTop || 0) - nextScrollTop) > 12) {
    container.scrollTop = nextScrollTop;
  }
}

function escapeText(value) {
  return value.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]);
}

function escapeAttr(value) {
  return escapeText(String(value)).replace(/"/g, "&quot;");
}
