const SVG_NS = "http://www.w3.org/2000/svg";

export function layoutDag(dagState, options = {}) {
  const direction = options.direction === "vertical" ? "vertical" : "horizontal";
  const allNodes = [...(dagState.nodes?.values() || [])].sort((left, right) => left.id - right.id);
  const allEdges = dagState.edges || [];
  const incoming = new Map(allNodes.map((node) => [node.id, []]));
  for (const edge of allEdges) {
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

  const nodesWithLevels = allNodes.map((node) => ({ ...node, level: levelOf(node.id) }));
  const windowedNodeIds = dagWindowNodeIds(nodesWithLevels, allEdges, options.maxNodes);
  const nodes = nodesWithLevels.filter((node) => windowedNodeIds.has(node.id));
  const edges = allEdges.filter((edge) => windowedNodeIds.has(edge.source) && windowedNodeIds.has(edge.target));
  const byLevel = new Map();
  for (const node of nodes) {
    const level = node.level;
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level).push(node);
  }

  if (direction === "vertical") {
    const graph = layoutVerticalDag(byLevel, edges, options);
    return { ...graph, totalNodeCount: allNodes.length, omittedNodeCount: allNodes.length - nodes.length };
  }

  const levelCount = Math.max(1, byLevel.size);
  const maxLevelSize = Math.max(1, ...[...byLevel.values()].map((items) => items.length));
  const width = Math.max(options.width || 420, 120 + levelCount * 110);
  const height = Math.max(options.height || 220, 80 + maxLevelSize * 68);
  const nodeWidth = 84;
  const nodeHeight = 34;
  const xPad = direction === "vertical" ? nodeWidth / 2 + 4 : 44;
  const yPad = 40;
  const xStep = levelCount <= 1 ? 0 : (width - xPad * 2) / (levelCount - 1);
  const yLevelStep = levelCount <= 1 ? 0 : (height - yPad * 2) / (levelCount - 1);

  const layoutNodes = [];
  for (const [level, items] of [...byLevel.entries()].sort((left, right) => left[0] - right[0])) {
    const yStep = items.length <= 1 ? 0 : (height - yPad * 2) / (items.length - 1);
    const xItemStep = items.length <= 1 ? 0 : (width - xPad * 2) / (items.length - 1);
    for (const [index, node] of items.entries()) {
      layoutNodes.push({
        ...node,
        level,
        x: direction === "vertical" ? (items.length === 1 ? width / 2 : xPad + index * xItemStep) : xPad + level * xStep,
        y: direction === "vertical" ? yPad + level * yLevelStep : items.length === 1 ? height / 2 : yPad + index * yStep,
        width: nodeWidth,
        height: nodeHeight,
      });
    }
  }

  const nodeById = new Map(layoutNodes.map((node) => [node.id, node]));
  const layoutEdges = edges
    .map((edge) => ({ ...edge, sourceNode: nodeById.get(edge.source), targetNode: nodeById.get(edge.target) }))
    .filter((edge) => edge.sourceNode && edge.targetNode);

  return {
    width,
    height,
    direction,
    nodes: layoutNodes.sort((left, right) => left.id - right.id),
    edges: layoutEdges,
    totalNodeCount: allNodes.length,
    omittedNodeCount: allNodes.length - nodes.length,
  };
}

function dagWindowNodeIds(nodes, edges, maxNodes) {
  const limit = Number(maxNodes);
  if (!Number.isFinite(limit) || limit <= 0 || nodes.length <= limit) {
    return new Set(nodes.map((node) => node.id));
  }

  const predecessorIds = new Map(nodes.map((node) => [node.id, []]));
  const successorIds = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (predecessorIds.has(edge.target)) predecessorIds.get(edge.target).push(edge.source);
    if (successorIds.has(edge.source)) successorIds.get(edge.source).push(edge.target);
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const selected = new Set();
  const queue = [];
  const enqueue = (id) => {
    if (!byId.has(id) || queue.includes(id)) return;
    queue.push(id);
  };
  const add = (id) => {
    if (!byId.has(id) || selected.has(id) || selected.size >= limit) return false;
    selected.add(id);
    return true;
  };

  const active = nodes.filter((node) => node.state === "active");
  const ready = nodes.filter((node) => node.state === "ready");
  const frontier = active.length ? active : ready.length ? ready : nodes.filter((node) => node.state !== "completed");
  const seeds = (frontier.length ? frontier : nodes.slice(-1)).sort((left, right) => left.id - right.id);

  for (const node of seeds) {
    if (add(node.id)) enqueue(node.id);
  }

  let cursor = 0;
  while (selected.size < limit && cursor < queue.length) {
    const id = queue[cursor];
    cursor += 1;
    const neighbors = [
      ...(predecessorIds.get(id) || []).sort((left, right) => right - left),
      ...(successorIds.get(id) || []).sort((left, right) => left - right),
    ];
    for (const neighbor of neighbors) {
      if (add(neighbor)) enqueue(neighbor);
      if (selected.size >= limit) break;
    }
  }

  for (const node of nodes) {
    if (selected.size >= limit) break;
    add(node.id);
  }

  return selected;
}

function layoutVerticalDag(byLevel, edges, options) {
  const requestedWidth = Math.max(options.width || 360, 240);
  const minHeight = Math.max(options.height || 520, 260);
  const width = requestedWidth;
  const nodeWidth = requestedWidth < 300 ? 64 : requestedWidth < 380 ? 74 : 82;
  const nodeHeight = 36;
  const xPad = 16;
  const yPad = 42;
  const nodeGap = 10;
  const rowGap = 12;
  const levelGap = 46;
  const availableWidth = Math.max(nodeWidth, width - xPad * 2);
  const maxPerRow = Math.max(1, Math.floor((availableWidth + nodeGap) / (nodeWidth + nodeGap)));

  const layoutNodes = [];
  let y = yPad;
  for (const [level, items] of [...byLevel.entries()].sort((left, right) => left[0] - right[0])) {
    const rows = chunk(items, maxPerRow);
    for (const row of rows) {
      const rowWidth = row.length * nodeWidth + Math.max(0, row.length - 1) * nodeGap;
      const startX = (width - rowWidth) / 2 + nodeWidth / 2;
      for (const [index, node] of row.entries()) {
        layoutNodes.push({
          ...node,
          level,
          x: startX + index * (nodeWidth + nodeGap),
          y: y + nodeHeight / 2,
          width: nodeWidth,
          height: nodeHeight,
        });
      }
      y += nodeHeight + rowGap;
    }
    y += levelGap;
  }

  const height = Math.max(minHeight, y + yPad - levelGap - rowGap);
  const nodeById = new Map(layoutNodes.map((node) => [node.id, node]));
  const layoutEdges = edges
    .map((edge) => ({ ...edge, sourceNode: nodeById.get(edge.source), targetNode: nodeById.get(edge.target) }))
    .filter((edge) => edge.sourceNode && edge.targetNode);

  return { width, height, direction: "vertical", nodes: layoutNodes.sort((left, right) => left.id - right.id), edges: layoutEdges };
}

function chunk(items, size) {
  const rows = [];
  for (let index = 0; index < items.length; index += size) {
    rows.push(items.slice(index, index + size));
  }
  return rows;
}

export function renderDagSvg(container, dagState, options = {}) {
  const rect = container.getBoundingClientRect();
  const graph = layoutDag(dagState, {
    width: Math.max(300, Math.floor(rect.width || 0)),
    height: Math.max(360, Math.floor(rect.height || 0)),
    direction: options.direction,
    maxNodes: options.maxNodes,
  });

  const svg = svgElement("svg", {
    class: "dag-svg",
    "data-total-nodes": graph.totalNodeCount,
    "data-omitted-nodes": graph.omittedNodeCount,
    viewBox: `0 0 ${graph.width} ${graph.height}`,
    width: graph.width,
    height: graph.height,
    role: "img",
    "aria-label": "Dependency DAG",
  });
  svg.appendChild(arrowMarker());
  if (graph.omittedNodeCount > 0) {
    svg.appendChild(dagWindowLabel(graph));
  }

  const edgeLayer = svgElement("g", { class: "dag-edge-layer" });
  for (const edge of graph.edges) {
    const source = edge.sourceNode;
    const target = edge.targetNode;
    edgeLayer.appendChild(dagEdgePath(graph.direction, source, target));
  }
  svg.appendChild(edgeLayer);

  const nodeLayer = svgElement("g", { class: "dag-node-layer" });
  for (const node of graph.nodes) {
    const group = svgElement("g", {
      class: `dag-svg-node ${node.state || "blocked"}`,
      "data-node-id": node.id,
      "data-state": node.state || "blocked",
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

function dagWindowLabel(graph) {
  const group = svgElement("g", { class: "dag-window-label" });
  group.appendChild(svgElement("rect", { x: 12, y: 10, width: 172, height: 24, rx: 6, ry: 6 }));
  const label = svgElement("text", { x: 22, y: 26 });
  label.textContent = `${graph.nodes.length}/${graph.totalNodeCount} ops in focus`;
  group.appendChild(label);
  return group;
}

function dagEdgePath(direction, source, target) {
  if (direction === "vertical") {
    const x1 = source.x;
    const y1 = source.y + source.height / 2;
    const x2 = target.x;
    const y2 = target.y - target.height / 2 - 4;
    const midY = y1 + Math.max(18, (y2 - y1) / 2);
    return svgElement("path", {
      class: "dag-edge",
      d: `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`,
      "marker-end": "url(#dag-arrow)",
    });
  }
  const x1 = source.x + source.width / 2;
  const y1 = source.y;
  const x2 = target.x - target.width / 2 - 4;
  const y2 = target.y;
  const midX = x1 + Math.max(24, (x2 - x1) / 2);
  return svgElement("path", {
    class: "dag-edge",
    d: `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`,
    "marker-end": "url(#dag-arrow)",
  });
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
