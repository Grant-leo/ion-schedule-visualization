const SVG_NS = "http://www.w3.org/2000/svg";
const COMPACT_NODE_THRESHOLD = 600;
const COMPACT_LABEL_STATES = new Set(["active"]);

export function layoutDag(dagState, options = {}) {
  const direction = options.direction === "vertical" ? "vertical" : "horizontal";
  const allNodes = [...(dagState.nodes?.values() || [])].sort((left, right) => left.id - right.id);
  const allEdges = dagState.edges || [];
  const compact = Boolean(options.compact ?? allNodes.length > COMPACT_NODE_THRESHOLD);
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

  const stallBySource = dagBottleneckMap(options.bottlenecks);
  const nodesWithLevels = allNodes.map((node) => {
    const stallTime = stallBySource.get(node.id);
    return {
      ...node,
      level: levelOf(node.id),
      ...(stallTime ? { bottleneck: true, releases_stall_time: stallTime } : {}),
    };
  });
  const nodes = nodesWithLevels;
  const edges = allEdges;
  const byLevel = new Map();
  for (const node of nodes) {
    const level = node.level;
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level).push(node);
  }

  if (direction === "vertical") {
    const graph = layoutVerticalDag(byLevel, edges, { ...options, compact });
    return { ...graph, totalNodeCount: allNodes.length, omittedNodeCount: 0, compact };
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
    omittedNodeCount: 0,
    compact,
  };
}

function layoutVerticalDag(byLevel, edges, options) {
  const requestedWidth = Math.max(options.width || 360, 240);
  const minHeight = Math.max(options.height || 520, 260);
  const width = requestedWidth;
  const compact = Boolean(options.compact);
  const nodeWidth = compact ? 24 : requestedWidth < 300 ? 64 : requestedWidth < 380 ? 74 : 82;
  const nodeHeight = compact ? 12 : 36;
  const xPad = 16;
  const yPad = 42;
  const nodeGap = compact ? 4 : 10;
  const rowGap = compact ? 6 : 12;
  const levelGap = compact ? 22 : 46;
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

  return { width, height, direction: "vertical", nodes: layoutNodes.sort((left, right) => left.id - right.id), edges: layoutEdges, compact };
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
    bottlenecks: options.bottlenecks,
  });
  const structureKey = dagStructureKey(graph);
  const existingSvg = container.firstElementChild;
  if (existingSvg?.getAttribute?.("data-dag-structure-key") === structureKey) {
    syncDagNodeStates(existingSvg, graph);
    return graph;
  }

  const svg = svgElement("svg", {
    class: `dag-svg${graph.compact ? " dag-svg-compact" : ""}`,
    "data-total-nodes": graph.totalNodeCount,
    "data-omitted-nodes": graph.omittedNodeCount,
    "data-dag-structure-key": structureKey,
    viewBox: `0 0 ${graph.width} ${graph.height}`,
    width: graph.width,
    height: graph.height,
    role: "img",
    "aria-label": "Dependency DAG",
  });
  if (!graph.compact) svg.appendChild(arrowMarker());

  const edgeLayer = svgElement("g", { class: "dag-edge-layer" });
  if (graph.compact) {
    appendCompactEdges(edgeLayer, graph);
  } else {
    for (const edge of graph.edges) {
      const source = edge.sourceNode;
      const target = edge.targetNode;
      edgeLayer.appendChild(dagEdgePath(graph.direction, source, target));
    }
  }
  svg.appendChild(edgeLayer);

  const nodeLayer = svgElement("g", { class: "dag-node-layer" });
  for (const node of graph.nodes) {
    const group = svgElement("g", {
      class: dagNodeClass(node, graph),
      "data-node-id": node.id,
      "data-state": node.state || "blocked",
      transform: `translate(${node.x - node.width / 2}, ${node.y - node.height / 2})`,
    });
    group.appendChild(svgElement("rect", { width: node.width, height: node.height, rx: graph.compact ? 2 : 6, ry: graph.compact ? 2 : 6 }));
    if (!graph.compact) {
      const label = svgElement("text", { x: node.width / 2, y: 14, "text-anchor": "middle" });
      label.textContent = formatNodeLabel(node);
      const qubits = svgElement("text", { x: node.width / 2, y: 27, "text-anchor": "middle", class: "dag-qubits" });
      qubits.textContent = formatNodeQubits(node);
      group.append(label, qubits);
    }
    nodeLayer.appendChild(group);
  }
  svg.appendChild(nodeLayer);
  appendCompactLabels(svg, graph);
  container.replaceChildren(svg);
  return graph;
}

function dagNodeClass(node, graph) {
  return `dag-svg-node ${node.state || "blocked"}${graph.compact ? " compact" : ""}${node.bottleneck ? " bottleneck" : ""}`;
}

function dagBottleneckMap(bottlenecks = {}) {
  const result = new Map();
  for (const stall of bottlenecks.dag_stalls || []) {
    const source = Number(stall.source);
    const stallTime = Number(stall.stall_time) || 0;
    if (!Number.isFinite(source) || stallTime <= 0) continue;
    result.set(source, Math.max(result.get(source) || 0, stallTime));
  }
  return result;
}

function formatNodeLabel(node) {
  return `${node.id}:${node.gate_name || "op"}`;
}

function formatNodeQubits(node) {
  return `q${(node.qubits || []).join(",q")}`;
}

function dagEdgePath(direction, source, target) {
  return svgElement("path", {
    class: "dag-edge",
    d: dagEdgePathD(direction, source, target),
    "marker-end": "url(#dag-arrow)",
  });
}

function dagEdgePathD(direction, source, target) {
  if (direction === "vertical") {
    const x1 = source.x;
    const y1 = source.y + source.height / 2;
    const x2 = target.x;
    const y2 = target.y - target.height / 2 - 4;
    const midY = y1 + Math.max(18, (y2 - y1) / 2);
    return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
  }
  const x1 = source.x + source.width / 2;
  const y1 = source.y;
  const x2 = target.x - target.width / 2 - 4;
  const y2 = target.y;
  const midX = x1 + Math.max(24, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
}

function appendCompactEdges(edgeLayer, graph) {
  const pathData = graph.edges
    .map((edge) => dagEdgePathD(graph.direction, edge.sourceNode, edge.targetNode))
    .join(" ");
  if (pathData) edgeLayer.appendChild(svgElement("path", { class: "dag-edge dag-edge-batch", d: pathData }));
}

function appendCompactLabels(svg, graph) {
  if (!graph.compact) return;
  const layer = svgElement("g", { class: "dag-highlight-label-layer" });
  for (const node of graph.nodes) {
    if (!COMPACT_LABEL_STATES.has(node.state || "blocked")) continue;
    const text = svgElement("text", {
      x: node.x,
      y: node.y - node.height / 2 - 4,
      "text-anchor": "middle",
      class: `dag-highlight-label ${node.state || "blocked"}`,
    });
    text.textContent = formatNodeLabel(node);
    layer.appendChild(text);
  }
  if (layer.childNodes.length) svg.appendChild(layer);
}

function syncDagNodeStates(svg, graph) {
  const nodeById = new Map(graph.nodes.map((node) => [String(node.id), node]));
  for (const element of svg.querySelectorAll(".dag-svg-node")) {
    const node = nodeById.get(element.getAttribute("data-node-id"));
    if (!node) continue;
    const state = node.state || "blocked";
    element.setAttribute("data-state", state);
    const className = dagNodeClass(node, graph);
    if (element.getAttribute("class") !== className) element.setAttribute("class", className);
  }
  svg.querySelector(".dag-highlight-label-layer")?.remove();
  appendCompactLabels(svg, graph);
}

function dagStructureKey(graph) {
  const nodeKey = graph.nodes
    .map((node) => `${node.id}:${node.level}:${node.x}:${node.y}:${node.width}:${node.height}`)
    .join("|");
  const edgeKey = graph.edges.map((edge) => `${edge.source}>${edge.target}`).join("|");
  return hashString(`${graph.direction}|${graph.width}|${graph.height}|${graph.compact}|${nodeKey}|${edgeKey}`);
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
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
