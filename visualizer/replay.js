const VALID_EVENT_TYPES = new Set(["gate", "split", "move", "merge"]);

export function validateTrace(trace) {
  const errors = [];
  if (!trace || typeof trace !== "object") {
    return { valid: false, errors: ["trace must be an object"] };
  }
  if (trace.schema_version !== "1.0") errors.push("unsupported schema_version");
  if (trace.device_type !== "ion_trap") errors.push("unsupported device_type");
  if (!Array.isArray(trace.particles)) errors.push("particles must be an array");
  if (!Array.isArray(trace.events)) errors.push("events must be an array");
  if (errors.length > 0) return { valid: false, errors };

  const topologyInfo = validateTopology(trace.topology || {}, errors);
  const occupancy = validateInitialParticles(trace.particles, topologyInfo, errors);
  const trapChains = buildInitialTrapChains(trace);
  const locations = new Map(trace.particles.map((particle) => [particle.id, particle.initial_location]));
  const sortedEvents = sortedTraceEvents(trace.events);
  const busyUntil = new Map();
  const trapBusyUntil = new Map();
  const segmentBusyUntil = new Map();
  const junctionBusyUntil = new Map();
  const pendingTransfers = [];
  const expectedEvents = trace.metrics?.event_count;
  if (expectedEvents !== undefined && expectedEvents !== trace.events.length) {
    errors.push(`metrics event_count ${expectedEvents} does not match ${trace.events.length} events`);
  }
  validateDagEvents(trace, sortedEvents, errors);

  for (const event of sortedEvents) {
    applyCompletedTransfers(pendingTransfers, locations, event.start);
    if (!validateEventShape(event, errors)) continue;
    validateEventLocations(event, topologyInfo, errors);
    validateEventTopology(event, topologyInfo, errors);
    validateEventEndpoint(event, topologyInfo.trapSegmentOrientation, errors);
    validateSplitEndpointIon(event, trapChains, errors);
    if (event.end < event.start) {
      errors.push(`event ${event.id} ends before it starts`);
    }
    const trapResource = eventTrapResource(event);
    if (trapResource && (trapBusyUntil.get(trapResource) || 0) > event.start) {
      errors.push(`${trapResource} busy until ${trapBusyUntil.get(trapResource)} for event ${event.id}`);
    }
    for (const segmentResource of eventSegmentResources(event)) {
      if ((segmentBusyUntil.get(segmentResource) || 0) > event.start) {
        errors.push(`${segmentResource} busy until ${segmentBusyUntil.get(segmentResource)} for event ${event.id}`);
      }
    }
    for (const junctionResource of eventJunctionResources(event, topologyInfo)) {
      if ((junctionBusyUntil.get(junctionResource) || 0) > event.start) {
        errors.push(`${junctionResource} busy until ${junctionBusyUntil.get(junctionResource)} for event ${event.id}`);
      }
    }
    for (const ion of event.ions || []) {
      if ((busyUntil.get(ion) || 0) > event.start) {
        errors.push(`ion ${ion} busy until ${busyUntil.get(ion)} for event ${event.id}`);
      }
      const current = locations.get(ion);
      if (event.type === "gate") {
        if (current !== event.target) {
          errors.push(`ion ${ion} not at ${event.target} for gate ${event.id}; current=${current}`);
        }
      } else if (current !== event.source) {
        errors.push(`ion ${ion} not at ${event.source} for ${event.type} ${event.id}; current=${current}`);
      }
      if (event.type === "split" && event.source?.startsWith("trap:")) {
        decrementTrapOccupancy(occupancy, event.source, event, errors);
        removeIonFromTrapChain(trapChains, event.source, ion);
      }
    }

    if (event.type !== "gate") {
      for (const ion of event.ions || []) {
        pendingTransfers.push({ end: event.end, ion, target: event.target, event });
      }
    }
    for (const ion of event.ions || []) {
      busyUntil.set(ion, Math.max(busyUntil.get(ion) || 0, event.end));
    }
    if (trapResource) {
      trapBusyUntil.set(trapResource, Math.max(trapBusyUntil.get(trapResource) || 0, event.end));
    }
    for (const segmentResource of eventSegmentResources(event)) {
      segmentBusyUntil.set(segmentResource, Math.max(segmentBusyUntil.get(segmentResource) || 0, event.end));
    }
    for (const junctionResource of eventJunctionResources(event, topologyInfo)) {
      junctionBusyUntil.set(junctionResource, Math.max(junctionBusyUntil.get(junctionResource) || 0, event.end));
    }
  }

  applyCompletedTransfers(pendingTransfers, locations, Number.POSITIVE_INFINITY);
  return { valid: errors.length === 0, errors };

  function applyCompletedTransfers(pendingTransfers, locations, time) {
    const chainEventsApplied = new Set();
    for (let index = pendingTransfers.length - 1; index >= 0; index -= 1) {
      const transfer = pendingTransfers[index];
      if (transfer.end <= time) {
        locations.set(transfer.ion, transfer.target);
        if (transfer.target?.startsWith("trap:")) {
          incrementTrapOccupancy(occupancy, topologyInfo.trapCapacity, transfer.target, transfer.event, errors);
          if (!chainEventsApplied.has(transfer.event.id)) {
            applyMergeToTrapChains(transfer.event, trapChains);
            chainEventsApplied.add(transfer.event.id);
          }
        }
        pendingTransfers.splice(index, 1);
      }
    }
  }
}

export function createReplay(trace, keyframeInterval = 100) {
  const validation = validateTrace(trace);
  if (!validation.valid) {
    throw new Error(`Invalid trace: ${validation.errors.join("; ")}`);
  }

  const events = sortedTraceEvents(trace.events);
  const initialLocations = new Map(trace.particles.map((particle) => [particle.id, particle.initial_location]));
  const initialTrapChains = buildInitialTrapChains(trace);
  const keyframes = buildKeyframes(events, initialLocations, initialTrapChains, keyframeInterval);
  const finishTime = events.reduce((maxTime, event) => Math.max(maxTime, event.end), 0);
  const metrics = summarize(events);

  return {
    trace,
    events,
    finishTime,
    stateAt(time) {
      const clampedTime = clamp(time, 0, finishTime);
      const keyframe = nearestKeyframe(keyframes, clampedTime);
      const locations = new Map(keyframe.locations);
      const trapChains = cloneTrapChains(keyframe.trapChains);
      const activeEvents = [];

      for (let index = keyframe.eventIndex; index < events.length; index += 1) {
        const event = events[index];
        if (event.start > clampedTime) break;
        if (event.end <= clampedTime && event.type !== "gate") {
          applyCompletedTransfer(event, locations, trapChains);
        }
        if (event.start <= clampedTime && clampedTime < event.end) {
          activeEvents.push(event);
        }
      }

      return {
        time: clampedTime,
        locations,
        activeEvents,
        motionTrapChains: cloneTrapChains(trapChains),
        trapChains: visibleTrapChains(trapChains, activeEvents),
        dagState: buildDagState(trace, events, activeEvents, clampedTime),
        metrics,
        progressMetrics: summarizeProgress(events, clampedTime, finishTime),
      };
    },
    nextEventTime(time) {
      const next = events.find((event) => event.start > time);
      return next ? next.start : finishTime;
    },
  };
}

function sortedTraceEvents(events) {
  return [...events].sort((left, right) => left.start - right.start || left.id - right.id);
}

function validateTopology(topology, errors) {
  const knownLocations = new Set();
  const trapCapacity = new Map();
  const trapSegmentOrientation = new Map();
  const segmentEndpoints = new Map();
  const trapIds = new Set();
  const junctionIds = new Set();
  const segmentIds = new Set();

  for (const trap of topology.traps || []) {
    const trapId = trap.id;
    if (trapIds.has(trapId)) errors.push(`duplicate trap id ${trapId}`);
    trapIds.add(trapId);
    const trapLocation = locationKey("trap", trapId);
    knownLocations.add(trapLocation);
    if (trap.capacity !== undefined && trap.capacity !== null) {
      trapCapacity.set(trapLocation, Number(trap.capacity));
    }
    for (const [segmentId, side] of Object.entries(trap.orientation || {})) {
      trapSegmentOrientation.set(`${trapLocation}|${locationKey("segment", segmentId)}`, side);
    }
  }

  for (const junction of topology.junctions || []) {
    const junctionId = junction.id;
    if (junctionIds.has(junctionId)) errors.push(`duplicate junction id ${junctionId}`);
    junctionIds.add(junctionId);
    knownLocations.add(locationKey("junction", junctionId));
  }

  for (const segment of topology.segments || []) {
    const segmentId = segment.id;
    if (segmentIds.has(segmentId)) errors.push(`duplicate segment id ${segmentId}`);
    segmentIds.add(segmentId);
    for (const endpointKey of ["from", "to"]) {
      const endpoint = segment[endpointKey];
      if (!knownLocations.has(endpoint)) {
        errors.push(`segment ${segmentId} unknown ${endpointKey} ${endpoint}`);
      }
    }
    const segmentLocation = locationKey("segment", segmentId);
    knownLocations.add(segmentLocation);
    segmentEndpoints.set(segmentLocation, new Set([segment.from, segment.to]));
  }

  return { knownLocations, trapCapacity, trapSegmentOrientation, segmentEndpoints };
}

function validateInitialParticles(particles, topologyInfo, errors) {
  const particleIds = new Set();
  const occupancy = new Map();
  for (const particle of particles || []) {
    if (particleIds.has(particle.id)) errors.push(`duplicate particle id ${particle.id}`);
    particleIds.add(particle.id);
    const location = particle.initial_location;
    if (!topologyInfo.knownLocations.has(location)) {
      errors.push(`particle ${particle.id} unknown initial_location ${location}`);
    }
    if (topologyInfo.trapCapacity.has(location)) {
      occupancy.set(location, (occupancy.get(location) || 0) + 1);
    }
  }
  for (const [location, count] of occupancy) {
    const capacity = topologyInfo.trapCapacity.get(location);
    if (count > capacity) {
      errors.push(`${location} initial occupancy ${count} exceeds capacity ${capacity}`);
    }
  }
  return occupancy;
}

function validateEventLocations(event, topologyInfo, errors) {
  if (event.source && !topologyInfo.knownLocations.has(event.source)) {
    errors.push(`event ${event.id} unknown source ${event.source}`);
  }
  if (event.target && !topologyInfo.knownLocations.has(event.target)) {
    errors.push(`event ${event.id} unknown target ${event.target}`);
  }
}

function validateEventTopology(event, topologyInfo, errors) {
  if (event.type === "split") {
    if (!event.source?.startsWith("trap:") || !event.target?.startsWith("segment:")) {
      errors.push(`event ${event.id} split must move from trap to segment`);
      return;
    }
    if (!topologyInfo.segmentEndpoints.get(event.target)?.has(event.source)) {
      errors.push(`event ${event.id} source ${event.source} not adjacent to ${event.target}`);
    }
    return;
  }

  if (event.type === "merge") {
    if (!event.source?.startsWith("segment:") || !event.target?.startsWith("trap:")) {
      errors.push(`event ${event.id} merge must move from segment to trap`);
      return;
    }
    if (!topologyInfo.segmentEndpoints.get(event.source)?.has(event.target)) {
      errors.push(`event ${event.id} source ${event.source} not adjacent to ${event.target}`);
    }
    return;
  }

  if (event.type === "move") {
    if (!event.source?.startsWith("segment:") || !event.target?.startsWith("segment:")) {
      errors.push(`event ${event.id} move must stay between channel segments`);
      return;
    }
    const sourceEndpoints = topologyInfo.segmentEndpoints.get(event.source) || new Set();
    const targetEndpoints = topologyInfo.segmentEndpoints.get(event.target) || new Set();
    const sharedJunction = [...sourceEndpoints].some((endpoint) => endpoint.startsWith("junction:") && targetEndpoints.has(endpoint));
    if (!sharedJunction) {
      errors.push(`event ${event.id} source ${event.source} not adjacent to ${event.target}`);
    }
  }
}

function validateEventShape(event, errors) {
  if (!VALID_EVENT_TYPES.has(event.type)) {
    errors.push(`unsupported event type ${event.type} for event ${event.id}`);
    return false;
  }

  if (!Array.isArray(event.ions) || event.ions.length === 0) {
    errors.push(`event ${event.id} must reference at least one ion`);
  }

  if (event.type === "gate") {
    if (event.source !== event.target || !event.target?.startsWith("trap:")) {
      errors.push(`gate event ${event.id} must execute inside one trap`);
    }
    if (!Number.isInteger(event.metadata?.gate_id)) {
      errors.push(`gate event ${event.id} must include integer metadata.gate_id`);
    }
    if (Number.isInteger(event.metadata?.arity) && event.metadata.arity !== (event.ions || []).length) {
      errors.push(`gate event ${event.id} arity ${event.metadata.arity} does not match ${(event.ions || []).length} ions`);
    }
  }

  return true;
}

function validateDagEvents(trace, events, errors) {
  const dag = trace.dag || {};
  const nodes = dag.nodes || [];
  const edges = dag.edges || [];
  if (nodes.length === 0 && edges.length === 0) return;

  const dagNodes = new Map();
  for (const node of nodes) {
    if (!Number.isInteger(node.id)) {
      errors.push(`dag node has non-integer id ${node.id}`);
      continue;
    }
    if (dagNodes.has(node.id)) {
      errors.push(`duplicate dag node id ${node.id}`);
    }
    dagNodes.set(node.id, node);
  }

  const gateEventsById = new Map();
  for (const event of events) {
    if (event.type !== "gate") continue;
    const gateId = event.metadata?.gate_id;
    if (!Number.isInteger(gateId)) continue;
    if (!dagNodes.has(gateId)) {
      errors.push(`gate event ${event.id} references unknown dag node ${gateId}`);
      continue;
    }
    if (gateEventsById.has(gateId)) {
      errors.push(`dag node ${gateId} has multiple matching gate events`);
      continue;
    }
    gateEventsById.set(gateId, event);
  }

  for (const nodeId of [...dagNodes.keys()].sort((left, right) => left - right)) {
    if (!gateEventsById.has(nodeId)) {
      errors.push(`dag node ${nodeId} has no matching gate event`);
    }
  }

  for (const edge of edges) {
    if (!dagNodes.has(edge.source)) {
      errors.push(`dag edge ${edge.source}->${edge.target} references unknown source`);
      continue;
    }
    if (!dagNodes.has(edge.target)) {
      errors.push(`dag edge ${edge.source}->${edge.target} references unknown target`);
      continue;
    }
    const sourceEvent = gateEventsById.get(edge.source);
    const targetEvent = gateEventsById.get(edge.target);
    if (!sourceEvent || !targetEvent) continue;
    if (sourceEvent.end > targetEvent.start) {
      errors.push(
        `dag edge ${edge.source}->${edge.target} violates event order: source ends at ${sourceEvent.end} but target starts at ${targetEvent.start}`,
      );
    }
  }
}

function validateEventEndpoint(event, trapSegmentOrientation, errors) {
  let trapLocation = null;
  let segmentLocation = null;
  if (event.type === "split") {
    trapLocation = event.source;
    segmentLocation = event.target;
  } else if (event.type === "merge") {
    trapLocation = event.target;
    segmentLocation = event.source;
  } else {
    return;
  }

  const expected = trapSegmentOrientation.get(`${trapLocation}|${segmentLocation}`);
  if (expected === undefined) return;
  const actual = event.metadata?.endpoint;
  if (actual !== expected) {
    errors.push(`event ${event.id} endpoint ${actual} does not match ${trapLocation} ${segmentLocation} orientation ${expected}`);
  }
}

function validateSplitEndpointIon(event, trapChains, errors) {
  if (event.type !== "split" || !event.source?.startsWith("trap:")) return;
  const endpoint = event.metadata?.endpoint;
  if (endpoint !== "L" && endpoint !== "R") return;
  const chain = trapChains.get(event.source) || [];
  for (const ion of event.ions || []) {
    const slot = chain.indexOf(ion);
    if (slot === -1) {
      errors.push(`event ${event.id} split ion ${ion} is not in ${event.source} chain`);
      continue;
    }
    const endpointSlot = endpoint === "L" ? 0 : chain.length - 1;
    const neededHops = Math.abs(slot - endpointSlot);
    if (neededHops === 0) continue;
    const swapHops = Number(event.metadata?.swap_hops || 0);
    const swapCount = Number(event.metadata?.swap_count || 0);
    if (swapCount <= 0 || swapHops < neededHops) {
      errors.push(
        `event ${event.id} split ion ${ion} is not at ${endpoint} endpoint of ${event.source}; ` +
          `slot ${slot}, endpoint slot ${endpointSlot}, needs ${neededHops} swap hops but metadata has ${swapHops}`,
      );
    }
  }
}

function decrementTrapOccupancy(occupancy, location, event, errors) {
  if (!location?.startsWith("trap:")) return;
  const next = (occupancy.get(location) || 0) - 1;
  occupancy.set(location, next);
  if (next < 0) errors.push(`${location} occupancy ${next} below zero after event ${event.id}`);
}

function incrementTrapOccupancy(occupancy, trapCapacity, location, event, errors) {
  const next = (occupancy.get(location) || 0) + 1;
  occupancy.set(location, next);
  const capacity = trapCapacity.get(location);
  if (capacity !== undefined && next > capacity) {
    errors.push(`${location} occupancy ${next} exceeds capacity ${capacity} after event ${event?.id}`);
  }
}

function locationKey(kind, id) {
  return `${kind}:${id}`;
}

function buildInitialTrapChains(trace) {
  const chains = new Map((trace.topology?.traps || []).map((trap) => [`trap:${trap.id}`, []]));
  const particles = [...trace.particles].sort(
    (left, right) => (left.initial_slot ?? left.id) - (right.initial_slot ?? right.id) || left.id - right.id,
  );
  for (const particle of particles) {
    const location = particle.initial_location;
    if (!location?.startsWith("trap:")) continue;
    if (!chains.has(location)) chains.set(location, []);
    chains.get(location).push(particle.id);
  }
  return chains;
}

function cloneTrapChains(trapChains) {
  return new Map([...trapChains.entries()].map(([location, ions]) => [location, [...ions]]));
}

function visibleTrapChains(trapChains, activeEvents) {
  const chains = cloneTrapChains(trapChains);
  for (const event of activeEvents) {
    if (event.type !== "split" || !event.source?.startsWith("trap:")) continue;
    const chain = chains.get(event.source);
    if (!chain) continue;
    for (const ion of event.ions || []) removeIon(chain, ion);
  }
  for (const event of activeEvents) {
    if (event.type !== "merge" || !event.target?.startsWith("trap:")) continue;
    const chain = chains.get(event.target) || [];
    for (const ion of event.ions || []) removeIon(chain, ion);
    const placeholders = (event.ions || []).map((ion) => `__merge:${event.id}:${ion}`);
    if (event.metadata?.endpoint === "L") {
      chain.splice(0, 0, ...placeholders);
    } else {
      chain.push(...placeholders);
    }
    chains.set(event.target, chain);
  }
  return chains;
}

function applyCompletedTransfer(event, locations, trapChains) {
  if (event.type === "split") {
    for (const ion of event.ions || []) removeIonFromTrapChain(trapChains, event.source, ion);
  } else if (event.type === "merge") {
    applyMergeToTrapChains(event, trapChains);
  }

  for (const ion of event.ions || []) {
    locations.set(ion, event.target);
  }
}

function removeIonFromTrapChain(trapChains, location, ion) {
  const chain = trapChains.get(location);
  if (chain) removeIon(chain, ion);
}

function applyMergeToTrapChains(event, trapChains) {
  if (event.type !== "merge" || !event.target?.startsWith("trap:")) return;
  const chain = trapChains.get(event.target) || [];
  for (const ion of event.ions || []) removeIon(chain, ion);
  const endpoint = event.metadata?.endpoint;
  if (endpoint === "L") {
    chain.splice(0, 0, ...(event.ions || []));
  } else {
    chain.push(...(event.ions || []));
  }
  trapChains.set(event.target, chain);
}

function removeIon(chain, ion) {
  const index = chain.indexOf(ion);
  if (index !== -1) chain.splice(index, 1);
}

function buildDagState(trace, events, activeEvents, time) {
  const dag = trace.dag || { nodes: [], edges: [] };
  const completed = new Set(
    events
      .filter((event) => event.type === "gate" && event.end <= time && Number.isInteger(event.metadata?.gate_id))
      .map((event) => event.metadata.gate_id),
  );
  const active = new Set(
    activeEvents
      .filter((event) => event.type === "gate" && Number.isInteger(event.metadata?.gate_id))
      .map((event) => event.metadata.gate_id),
  );
  const predecessors = new Map(dag.nodes.map((node) => [node.id, []]));
  for (const edge of dag.edges || []) {
    if (!predecessors.has(edge.target)) predecessors.set(edge.target, []);
    predecessors.get(edge.target).push(edge.source);
  }

  const nodes = new Map();
  for (const node of dag.nodes || []) {
    let state = "blocked";
    if (completed.has(node.id)) {
      state = "completed";
    } else if (active.has(node.id)) {
      state = "active";
    } else if ((predecessors.get(node.id) || []).every((source) => completed.has(source))) {
      state = "ready";
    }
    nodes.set(node.id, { ...node, state });
  }

  return { nodes, edges: dag.edges || [], completed, active };
}

function buildKeyframes(events, initialLocations, initialTrapChains, interval) {
  const safeInterval = Math.max(1, Number(interval) || 1);
  const keyframes = [{ time: 0, eventIndex: 0, locations: new Map(initialLocations), trapChains: cloneTrapChains(initialTrapChains) }];
  const locations = new Map(initialLocations);
  const trapChains = cloneTrapChains(initialTrapChains);
  const completedTransfers = events
    .filter((event) => event.type !== "gate")
    .sort((left, right) => left.end - right.end || left.start - right.start || left.id - right.id);
  const checkpointTimes = [
    ...new Set(
      events
        .slice(safeInterval - 1)
        .filter((_, index) => index % safeInterval === 0)
        .map((event) => event.end)
        .sort((left, right) => left - right),
    ),
  ];
  let transferIndex = 0;

  for (const time of checkpointTimes) {
    while (transferIndex < completedTransfers.length && completedTransfers[transferIndex].end <= time) {
      const event = completedTransfers[transferIndex];
      applyCompletedTransfer(event, locations, trapChains);
      transferIndex += 1;
    }
    keyframes.push({
      time,
      eventIndex: firstEventEndingAfter(events, time),
      locations: new Map(locations),
      trapChains: cloneTrapChains(trapChains),
    });
  }

  return keyframes;
}

function firstEventEndingAfter(events, time) {
  const index = events.findIndex((event) => event.end > time);
  return index === -1 ? events.length : index;
}

function nearestKeyframe(keyframes, time) {
  let selected = keyframes[0];
  for (const keyframe of keyframes) {
    if (keyframe.time <= time) {
      selected = keyframe;
    } else {
      break;
    }
  }
  return selected;
}

function summarize(events) {
  const counts = { gate: 0, split: 0, move: 0, merge: 0 };
  const times = { gate: 0, split: 0, move: 0, merge: 0 };
  let swapCount = 0;
  let swapHops = 0;
  let ionHops = 0;
  let oneQubitGates = 0;
  let twoQubitGates = 0;

  for (const event of events) {
    counts[event.type] = (counts[event.type] || 0) + 1;
    times[event.type] = (times[event.type] || 0) + Math.max(0, event.end - event.start);
    if (event.type === "gate") {
      if (Number(event.metadata?.arity ?? event.ions?.length ?? 0) === 1) {
        oneQubitGates += 1;
      } else {
        twoQubitGates += 1;
      }
    }
    if (event.type === "split") {
      swapCount += Number(event.metadata?.swap_count || 0);
      swapHops += Number(event.metadata?.swap_hops || 0);
      ionHops += Number(event.metadata?.ion_hops || 0);
    }
  }
  const parallel = summarizeGateParallelism(events);

  return {
    counts,
    times,
    eventCount: events.length,
    finishTime: events.reduce((maxTime, event) => Math.max(maxTime, event.end), 0),
    shuttlingTime: times.split + times.move + times.merge,
    oneQubitGates,
    twoQubitGates,
    swapCount,
    swapHops,
    ionHops,
    ...parallel,
  };
}

function summarizeProgress(events, time, finishTime) {
  const counts = { gate: 0, split: 0, move: 0, merge: 0 };
  const times = { gate: 0, split: 0, move: 0, merge: 0 };
  let activeShuttlingOps = 0;

  for (const event of events) {
    const type = event.type;
    if (event.start <= time) {
      counts[type] = (counts[type] || 0) + 1;
    }

    const elapsed = Math.max(0, Math.min(time, event.end) - event.start);
    if (elapsed > 0) {
      times[type] = (times[type] || 0) + elapsed;
    }

    if (isShuttlingEvent(event) && event.start <= time && time < event.end) {
      activeShuttlingOps += 1;
    }
  }

  const shuttlingTime = times.split + times.move + times.merge;
  const shuttlingOps = counts.split + counts.move + counts.merge;
  return {
    counts,
    times,
    elapsedTime: time,
    finishTime,
    shuttlingTime,
    shuttlingOps,
    activeShuttlingOps,
  };
}

function summarizeGateParallelism(events) {
  const gates = events.filter((event) => event.type === "gate");
  let maxParallelGates = 0;
  let crossTrapParallelGates = 0;
  let sameTrapGateOverlaps = 0;

  for (let index = 0; index < gates.length; index += 1) {
    const left = gates[index];
    const activeAtStart = gates.filter((gate) => gate.start <= left.start && left.start < gate.end);
    maxParallelGates = Math.max(maxParallelGates, activeAtStart.length);
    if (new Set(activeAtStart.map((gate) => gate.target)).size > 1) {
      crossTrapParallelGates += 1;
    }

    for (const right of gates.slice(index + 1)) {
      if (left.target !== right.target) continue;
      if (left.start < right.end && right.start < left.end) {
        sameTrapGateOverlaps += 1;
      }
    }
  }

  return { maxParallelGates, crossTrapParallelGates, sameTrapGateOverlaps };
}

function isShuttlingEvent(event) {
  return event.type === "split" || event.type === "move" || event.type === "merge";
}

function eventTrapResource(event) {
  if (event.type === "gate" && event.target?.startsWith("trap:")) return event.target;
  if (event.type === "split" && event.source?.startsWith("trap:")) return event.source;
  if (event.type === "merge" && event.target?.startsWith("trap:")) return event.target;
  return null;
}

function eventSegmentResources(event) {
  const resources = [];
  if (event.type === "split" && event.target?.startsWith("segment:")) {
    resources.push(event.target);
  } else if (event.type === "merge" && event.source?.startsWith("segment:")) {
    resources.push(event.source);
  } else if (event.type === "move") {
    for (const location of [event.source, event.target]) {
      if (location?.startsWith("segment:") && !resources.includes(location)) resources.push(location);
    }
  }
  return resources;
}

function eventJunctionResources(event, topologyInfo) {
  if (event.type !== "move") return [];
  const sourceEndpoints = topologyInfo.segmentEndpoints.get(event.source) || new Set();
  const targetEndpoints = topologyInfo.segmentEndpoints.get(event.target) || new Set();
  return [...sourceEndpoints]
    .filter((endpoint) => endpoint.startsWith("junction:") && targetEndpoints.has(endpoint))
    .sort();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}
