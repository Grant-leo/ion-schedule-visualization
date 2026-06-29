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

  const locations = new Map(trace.particles.map((particle) => [particle.id, particle.initial_location]));
  const sortedEvents = sortedTraceEvents(trace.events);
  const busyUntil = new Map();
  const trapBusyUntil = new Map();
  const pendingTransfers = [];

  for (const event of sortedEvents) {
    applyCompletedTransfers(pendingTransfers, locations, event.start);
    if (event.end < event.start) {
      errors.push(`event ${event.id} ends before it starts`);
    }
    const trapResource = eventTrapResource(event);
    if (trapResource && (trapBusyUntil.get(trapResource) || 0) > event.start) {
      errors.push(`${trapResource} busy until ${trapBusyUntil.get(trapResource)} for event ${event.id}`);
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
    }

    if (event.type !== "gate") {
      for (const ion of event.ions || []) {
        pendingTransfers.push({ end: event.end, ion, target: event.target });
      }
    }
    for (const ion of event.ions || []) {
      busyUntil.set(ion, Math.max(busyUntil.get(ion) || 0, event.end));
    }
    if (trapResource) {
      trapBusyUntil.set(trapResource, Math.max(trapBusyUntil.get(trapResource) || 0, event.end));
    }
  }

  applyCompletedTransfers(pendingTransfers, locations, Number.POSITIVE_INFINITY);
  return { valid: errors.length === 0, errors };
}

export function createReplay(trace, keyframeInterval = 100) {
  const validation = validateTrace(trace);
  if (!validation.valid) {
    throw new Error(`Invalid trace: ${validation.errors.join("; ")}`);
  }

  const events = sortedTraceEvents(trace.events);
  const initialLocations = new Map(trace.particles.map((particle) => [particle.id, particle.initial_location]));
  const keyframes = buildKeyframes(events, initialLocations, keyframeInterval);
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
      const activeEvents = [];

      for (let index = keyframe.eventIndex; index < events.length; index += 1) {
        const event = events[index];
        if (event.start > clampedTime) break;
        if (event.end <= clampedTime && event.type !== "gate") {
          for (const ion of event.ions) {
            locations.set(ion, event.target);
          }
        }
        if (event.start <= clampedTime && clampedTime < event.end) {
          activeEvents.push(event);
        }
      }

      return {
        time: clampedTime,
        locations,
        activeEvents,
        trapChains: buildTrapChains(trace, locations, activeEvents),
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

function applyCompletedTransfers(pendingTransfers, locations, time) {
  for (let index = pendingTransfers.length - 1; index >= 0; index -= 1) {
    const transfer = pendingTransfers[index];
    if (transfer.end <= time) {
      locations.set(transfer.ion, transfer.target);
      pendingTransfers.splice(index, 1);
    }
  }
}

function buildTrapChains(trace, locations, activeEvents) {
  const chains = new Map((trace.topology?.traps || []).map((trap) => [`trap:${trap.id}`, []]));
  const activeDepartures = new Set();

  for (const event of activeEvents) {
    if (event.type === "split" && event.source?.startsWith("trap:")) {
      for (const ion of event.ions || []) activeDepartures.add(`${event.source}:${ion}`);
    }
  }

  const particles = [...trace.particles].sort(
    (left, right) => (left.initial_slot ?? left.id) - (right.initial_slot ?? right.id) || left.id - right.id,
  );
  for (const particle of particles) {
    const location = locations.get(particle.id) || particle.initial_location;
    if (!location?.startsWith("trap:")) continue;
    if (activeDepartures.has(`${location}:${particle.id}`)) continue;
    if (!chains.has(location)) chains.set(location, []);
    chains.get(location).push(particle.id);
  }

  return chains;
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

function buildKeyframes(events, initialLocations, interval) {
  const safeInterval = Math.max(1, Number(interval) || 1);
  const keyframes = [{ time: 0, eventIndex: 0, locations: new Map(initialLocations) }];
  const locations = new Map(initialLocations);

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.type !== "gate") {
      for (const ion of event.ions) {
        locations.set(ion, event.target);
      }
    }
    if ((index + 1) % safeInterval === 0) {
      keyframes.push({ time: event.end, eventIndex: index + 1, locations: new Map(locations) });
    }
  }

  return keyframes;
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}
