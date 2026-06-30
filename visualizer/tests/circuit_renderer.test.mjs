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
  assert.match(svg, /q_0/);
  assert.match(svg, /q_1/);
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
