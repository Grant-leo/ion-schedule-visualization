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
  const pendingTransfers = [];

  for (const event of sortedEvents) {
    applyCompletedTransfers(pendingTransfers, locations, event.start);
    if (event.end < event.start) {
      errors.push(`event ${event.id} ends before it starts`);
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

      return { time: clampedTime, locations, activeEvents, metrics };
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

  for (const event of events) {
    counts[event.type] = (counts[event.type] || 0) + 1;
    times[event.type] = (times[event.type] || 0) + Math.max(0, event.end - event.start);
  }

  return {
    counts,
    times,
    eventCount: events.length,
    finishTime: events.reduce((maxTime, event) => Math.max(maxTime, event.end), 0),
    shuttlingTime: times.split + times.move + times.merge,
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}
