import test from "node:test";
import assert from "node:assert/strict";

import { layoutDag } from "../dag_renderer.js";

test("layoutDag places Qiskit-style DAG nodes by dependency layer and keeps edges", () => {
  const dagState = {
    nodes: new Map([
      [0, { id: 0, gate_name: "h", qubits: [0], state: "completed" }],
      [1, { id: 1, gate_name: "cx", qubits: [0, 1], state: "active" }],
      [2, { id: 2, gate_name: "x", qubits: [1], state: "blocked" }],
    ]),
    edges: [
      { source: 0, target: 1 },
      { source: 1, target: 2 },
    ],
  };

  const graph = layoutDag(dagState, { width: 360, height: 180 });

  assert.deepEqual(
    graph.nodes.map((node) => ({ id: node.id, level: node.level })),
    [
      { id: 0, level: 0 },
      { id: 1, level: 1 },
      { id: 2, level: 2 },
    ],
  );
  assert.equal(graph.edges.length, 2);
  assert.ok(graph.nodes[0].x < graph.nodes[1].x);
  assert.ok(graph.nodes[1].x < graph.nodes[2].x);
});
