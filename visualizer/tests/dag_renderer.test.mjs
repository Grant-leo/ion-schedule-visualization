import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

test("layoutDag supports a vertical dependency page layout", () => {
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

  const graph = layoutDag(dagState, { width: 260, height: 500, direction: "vertical" });

  assert.ok(graph.nodes[0].y < graph.nodes[1].y);
  assert.ok(graph.nodes[1].y < graph.nodes[2].y);
  assert.equal(graph.direction, "vertical");
});

test("layoutDag keeps vertical DAG within the inspector width", () => {
  const dagState = {
    nodes: new Map(
      Array.from({ length: 8 }, (_, id) => [
        id,
        { id, gate_name: id % 2 === 0 ? "rz" : "cx", qubits: [id % 4], state: "ready" },
      ]),
    ),
    edges: [],
  };

  const graph = layoutDag(dagState, { width: 320, height: 420, direction: "vertical" });

  assert.equal(graph.width, 320);
  assert.ok(Math.max(...graph.nodes.map((node) => node.x + node.width / 2)) <= graph.width);
  assert.ok(Math.min(...graph.nodes.map((node) => node.x - node.width / 2)) >= 0);
});

test("layoutDag wraps dense vertical DAG levels instead of overlapping nodes", () => {
  const dagState = {
    nodes: new Map(
      Array.from({ length: 36 }, (_, id) => [
        id,
        { id, gate_name: id % 3 === 0 ? "h" : "cx", qubits: [id % 9], state: "ready" },
      ]),
    ),
    edges: [],
  };

  const graph = layoutDag(dagState, { width: 340, height: 420, direction: "vertical" });
  const nodes = graph.nodes;
  const overlaps = [];
  for (const [index, left] of nodes.entries()) {
    for (const right of nodes.slice(index + 1)) {
      const separatedX = left.x + left.width / 2 + 8 <= right.x - right.width / 2 ||
        right.x + right.width / 2 + 8 <= left.x - left.width / 2;
      const separatedY = left.y + left.height / 2 + 8 <= right.y - right.height / 2 ||
        right.y + right.height / 2 + 8 <= left.y - left.height / 2;
      if (!separatedX && !separatedY) overlaps.push([left.id, right.id]);
    }
  }

  assert.equal(overlaps.length, 0);
  assert.ok(new Set(nodes.map((node) => Math.round(node.y))).size > 1);
  assert.ok(graph.height > 420);
});

test("layoutDag preserves every node and dependency for very large DAGs", () => {
  const nodes = new Map(
    Array.from({ length: 500 }, (_, id) => [
      id,
      {
        id,
        gate_name: id % 5 === 0 ? "cx" : "rz",
        qubits: [id % 16],
        state: id === 250 ? "active" : id < 250 ? "completed" : "blocked",
      },
    ]),
  );
  const edges = Array.from({ length: 499 }, (_, id) => ({ source: id, target: id + 1 }));

  const graph = layoutDag({ nodes, edges }, { width: 420, height: 620, direction: "vertical" });
  const ids = new Set(graph.nodes.map((node) => node.id));

  assert.equal(graph.nodes.length, 500);
  assert.equal(graph.totalNodeCount, 500);
  assert.equal(graph.omittedNodeCount, 0);
  assert.ok(ids.has(250));
  assert.ok(ids.has(249));
  assert.ok(ids.has(251));
  assert.equal(graph.edges.length, 499);
  assert.ok(graph.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target)));
});

test("DAG stylesheet dims only executed dependency nodes", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

  assert.match(css, /\.dag-svg-node\.completed\s*{[^}]*opacity:\s*0\.\d+/s);
  assert.doesNotMatch(css, /\.dag-svg-node\.(active|ready|blocked)\s*{[^}]*opacity\s*:/s);
  assert.doesNotMatch(css, /\.dag-svg-node\.blocked\s+text\s*{/);
});
