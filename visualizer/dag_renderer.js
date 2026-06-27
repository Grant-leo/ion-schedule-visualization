const SVG_NS = "http://www.w3.org/2000/svg";

export function layoutDag(dagState, options = {}) {
  const nodes = [...(dagState.nodes?.values() || [])].sort((left, right) => left.id - right.id);
  const edges = dagState.edges || [];
  const incoming = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (!incoming.has(edge.target)) incoming.set(edge.target, []);
    incoming.get(edge.target).push(edge.source);
  }

  const levels = new Map();
  const visiting = new Set();
  const levelOf = (id) => {
    if (levels.has(id)) return levels.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const level = Math.max(-1, ...(incoming.get(id) || []).map(levelOf)) + 1;
    visiting.delete(id);
    levels.set(id, level);
    return level;
  };

  const byLevel = new Map();
  for (const node of nodes) {
    const level = levelOf(node.id);
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level).push(node);
  }

  const levelCount = Math.max(1, byLevel.size);
  const maxLevelSize = Math.max(1, ...[...byLevel.values()].map((items) => items.length));
  const width = Math.max(options.width || 420, 120 + levelCount * 110);
  const height = Math.max(options.height || 220, 80 + maxLevelSize * 68);
  const nodeWidth = 84;
  const nodeHeight = 34;
  const xPad = 44;
  const yPad = 40;
  const xStep = levelCount <= 1 ? 0 : (width - xPad * 2) / (levelCount - 1);

  const layoutNodes = [];
  for (const [level, items] of [...byLevel.entries()].sort((left, right) => left[0] - right[0])) {
    const yStep = items.length <= 1 ? 0 : (height - yPad * 2) / (items.length - 1);
    for (const [index, node] of items.entries()) {
      layoutNodes.push({
        ...node,
        level,
        x: xPad + level * xStep,
        y: items.length === 1 ? height / 2 : yPad + index * yStep,
        width: nodeWidth,
        height: nodeHeight,
      });
    }
  }

  const nodeById = new Map(layoutNodes.map((node) => [node.id, node]));
  const layoutEdges = edges
    .map((edge) => ({ ...edge, sourceNode: nodeById.get(edge.source), targetNode: nodeById.get(edge.target) }))
    .filter((edge) => edge.sourceNode && edge.targetNode);

  return { width, height, nodes: layoutNodes.sort((left, right) => left.id - right.id), edges: layoutEdges };
}

export function renderDagSvg(container, dagState) {
  const rect = container.getBoundingClientRect();
  const graph = layoutDag(dagState, {
    width: Math.max(360, Math.floor(rect.width || 0)),
    height: 240,
  });

  const svg = svgElement("svg", {
    class: "dag-svg",
    viewBox: `0 0 ${graph.width} ${graph.height}`,
    width: graph.width,
    height: graph.height,
    role: "img",
    "aria-label": "Dependency DAG",
  });
  svg.appendChild(arrowMarker());

  const edgeLayer = svgElement("g", { class: "dag-edge-layer" });
  for (const edge of graph.edges) {
    const source = edge.sourceNode;
    const target = edge.targetNode;
    const x1 = source.x + source.width / 2;
    const y1 = source.y;
    const x2 = target.x - target.width / 2 - 4;
    const y2 = target.y;
    const midX = x1 + Math.max(24, (x2 - x1) / 2);
    edgeLayer.appendChild(
      svgElement("path", {
        class: "dag-edge",
        d: `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`,
        "marker-end": "url(#dag-arrow)",
      }),
    );
  }
  svg.appendChild(edgeLayer);

  const nodeLayer = svgElement("g", { class: "dag-node-layer" });
  for (const node of graph.nodes) {
    const group = svgElement("g", {
      class: `dag-svg-node ${node.state || "blocked"}`,
      transform: `translate(${node.x - node.width / 2}, ${node.y - node.height / 2})`,
    });
    group.appendChild(svgElement("rect", { width: node.width, height: node.height, rx: 6, ry: 6 }));
    const label = svgElement("text", { x: node.width / 2, y: 14, "text-anchor": "middle" });
    label.textContent = `${node.id}:${node.gate_name || "op"}`;
    const qubits = svgElement("text", { x: node.width / 2, y: 27, "text-anchor": "middle", class: "dag-qubits" });
    qubits.textContent = `q${(node.qubits || []).join(",q")}`;
    group.append(label, qubits);
    nodeLayer.appendChild(group);
  }
  svg.appendChild(nodeLayer);
  container.replaceChildren(svg);
}

function arrowMarker() {
  const defs = svgElement("defs");
  const marker = svgElement("marker", {
    id: "dag-arrow",
    markerWidth: 8,
    markerHeight: 8,
    refX: 7,
    refY: 4,
    orient: "auto",
  });
  marker.appendChild(svgElement("path", { d: "M 0 0 L 8 4 L 0 8 z", class: "dag-arrow" }));
  defs.appendChild(marker);
  return defs;
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, String(value));
  }
  return element;
}
