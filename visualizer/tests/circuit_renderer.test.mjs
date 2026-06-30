import test from "node:test";
import assert from "node:assert/strict";

import { layoutCircuit, renderCircuitSvg } from "../circuit_renderer.js";

test("layoutCircuit creates TikZ-style wires and gate columns from DAG nodes", () => {
  const dagState = {
    nodes: new Map([
      [0, { id: 0, gate_name: "h", qubits: [0], state: "completed" }],
      [1, { id: 1, gate_name: "cx", qubits: [0, 2], state: "active" }],
      [2, { id: 2, gate_name: "rz", qubits: [1], state: "ready" }],
    ]),
    edges: [],
  };

  const layout = layoutCircuit(dagState, { qubitCount: 3, maxWidth: 360 });

  assert.deepEqual(layout.qubits, [0, 1, 2]);
  assert.equal(layout.gates.length, 3);
  assert.equal(layout.gates[1].kind, "cx");
  assert.equal(layout.gates[1].state, "active");
  assert.ok(layout.width > 0);
  assert.ok(layout.height > 0);
});

test("layoutCircuit keeps dense circuits readable by preserving gate spacing", () => {
  const nodes = new Map();
  for (let id = 0; id < 720; id += 1) {
    nodes.set(id, { id, gate_name: "h", qubits: [id % 48], state: "ready" });
  }

  const layout = layoutCircuit({ nodes, edges: [] }, { qubitCount: 48, maxWidth: 360 });

  assert.ok(layout.columnWidth >= 36);
  assert.ok(layout.rowGap >= 24);
});

test("layoutCircuit keeps the opening gates clear of labels and focus badges", () => {
  const dagState = {
    nodes: new Map([
      [0, { id: 0, gate_name: "h", qubits: [0], state: "active" }],
      [1, { id: 1, gate_name: "h", qubits: [1], state: "ready" }],
      [2, { id: 2, gate_name: "cx", qubits: [0, 1], state: "blocked" }],
    ]),
    edges: [],
  };

  const layout = layoutCircuit(dagState, { qubitCount: 2, maxWidth: 360 });

  assert.ok(layout.left >= 80);
  assert.ok(layout.top >= 32);
  assert.ok(layout.columnWidth >= 52);
  assert.ok(layout.gates[0].x - 13 > layout.left - 24);
});

test("renderCircuitSvg updates node state classes without omitting DAG gates", () => {
  const container = fakeContainer();
  const dagState = {
    nodes: new Map([
      [0, { id: 0, gate_name: "h", qubits: [0], state: "completed" }],
      [1, { id: 1, gate_name: "cx", qubits: [0, 1], state: "active" }],
      [2, { id: 2, gate_name: "x", qubits: [1], state: "blocked" }],
    ]),
    edges: [],
  };

  renderCircuitSvg(container, dagState, { qubitCount: 2, maxWidth: 360 });

  const svg = String(container.children[0] || "");
  assert.match(svg, /class="circuit-svg"/);
  assert.match(svg, /data-node-count="3"/);
  assert.match(svg, /circuit-gate completed/);
  assert.match(svg, /circuit-gate active/);
  assert.match(svg, /circuit-gate blocked/);
  assert.doesNotMatch(svg, /q_0/);
  assert.doesNotMatch(svg, /q_1/);
  assert.match(svg, />q<tspan class="circuit-qubit-subscript" baseline-shift="sub" font-size="70%">0<\/tspan></);
  assert.match(svg, />q<tspan class="circuit-qubit-subscript" baseline-shift="sub" font-size="70%">1<\/tspan></);
});

test("renderCircuitSvg marks the active gate with a visible focus band and label", () => {
  const container = fakeContainer();
  const dagState = {
    nodes: new Map([
      [0, { id: 0, gate_name: "h", qubits: [0], state: "completed" }],
      [1, { id: 1, gate_name: "cx", qubits: [0, 2], state: "active" }],
      [2, { id: 2, gate_name: "rz", qubits: [1], state: "ready" }],
    ]),
    edges: [],
  };

  renderCircuitSvg(container, dagState, { qubitCount: 3, maxWidth: 360 });

  const svg = String(container.children[0] || "");
  assert.match(svg, /class="circuit-focus-band"/);
  assert.match(svg, /class="circuit-active-label"/);
  assert.match(svg, /data-active-gate="1"/);
  assert.match(svg, />CX q0,q2</);
});

test("renderCircuitSvg scrolls the circuit strip toward the active gate", () => {
  const container = fakeDomContainer();
  const nodes = new Map();
  for (let id = 0; id < 30; id += 1) {
    nodes.set(id, { id, gate_name: id === 24 ? "cx" : "h", qubits: id === 24 ? [0, 1] : [0], state: id === 24 ? "active" : "ready" });
  }

  renderCircuitSvg(container, { nodes, edges: [] }, { qubitCount: 2, maxWidth: 160 });

  assert.ok(container.scrollLeft > 0);
});

function fakeContainer() {
  return {
    children: [],
    replaceChildren(...items) {
      this.children = items;
    },
    scrollLeft: 0,
    clientWidth: 360,
  };
}

function fakeDomContainer() {
  return {
    innerHTML: "",
    scrollLeft: 0,
    scrollTop: 0,
    clientWidth: 160,
    clientHeight: 70,
  };
}
