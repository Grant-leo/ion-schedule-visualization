from collections import defaultdict


ATTRIBUTION_MODEL = {
    "name": "qccd-bottleneck-attribution",
    "version": "0.1",
    "mode": "post-hoc-trace-analysis",
}


def build_resource_timeline(trace):
    """Build deterministic resource occupancy intervals from trace events."""
    timeline = defaultdict(list)
    topology = trace.get("topology") if isinstance(trace, dict) else {}
    for event in sorted(_events(trace), key=_event_sort_key):
        interval = _interval(event)
        if interval is None:
            continue
        for resource in _event_resources(event, topology):
            timeline[resource].append(dict(interval))
    return {resource: intervals for resource, intervals in sorted(timeline.items())}


def analyze_trace_bottlenecks(trace):
    timeline = build_resource_timeline(trace)
    gate_stalls = _gate_stalls(trace, timeline)
    hotspots = _top_resource_hotspots(timeline)
    total_gate_wait = sum(item["wait_time"] for item in gate_stalls)
    explained_wait = sum(item["wait_time"] for item in gate_stalls if item["primary_wait_reason"] != "scheduler_gap_unknown")
    return {
        "trace_hash": trace.get("trace_hash"),
        "attribution_model": dict(ATTRIBUTION_MODEL),
        "summary": {
            "gate_count": len(_dag_nodes(trace)),
            "event_count": len(_events(trace)),
            "total_gate_wait_time": total_gate_wait,
            "explained_gate_wait_time": explained_wait,
            "unexplained_gate_wait_time": total_gate_wait - explained_wait,
        },
        "resource_timeline": timeline,
        "top_resource_hotspots": hotspots,
        "gate_stalls": gate_stalls,
        "top_gate_stalls": sorted(gate_stalls, key=lambda item: (-item["wait_time"], item["gate_id"]))[:10],
    }


def _gate_stalls(trace, timeline):
    dag_nodes = _dag_nodes(trace)
    predecessors = _predecessors(trace)
    gate_events = _gate_events_by_id(trace)
    result = []
    for gate_id in sorted(dag_nodes):
        node = dag_nodes[gate_id]
        event = gate_events.get(gate_id)
        if event is None:
            continue
        dependency_ready_time = max(
            (gate_events[pred].get("end", 0) for pred in predecessors.get(gate_id, []) if pred in gate_events),
            default=0,
        )
        scheduled_start = _number(event.get("start"))
        scheduled_end = _number(event.get("end"))
        wait_time = max(0, scheduled_start - dependency_ready_time)
        reason, blockers = _wait_reason(event, dependency_ready_time, scheduled_start, timeline)
        result.append(
            {
                "gate_id": gate_id,
                "gate_name": node.get("gate_name") or (event.get("metadata") or {}).get("gate_name"),
                "qubits": node.get("qubits") or [],
                "target": event.get("target"),
                "scheduled_start": scheduled_start,
                "scheduled_end": scheduled_end,
                "dependency_ready_time": dependency_ready_time,
                "wait_time": wait_time,
                "primary_wait_reason": reason if wait_time > 0 else "none",
                "blocking_resources": blockers if wait_time > 0 else [],
            }
        )
    return result


def _wait_reason(gate_event, ready_time, start_time, timeline):
    if start_time <= ready_time:
        return "none", []
    window_start = ready_time
    window_end = start_time
    ion_resources = [f"ion:{ion}" for ion in gate_event.get("ions") or []]
    blockers = _busy_resources(timeline, ion_resources, window_start, window_end)
    if blockers:
        return "ion_not_colocated", blockers
    trap_resource = gate_event.get("target")
    if isinstance(trap_resource, str) and trap_resource.startswith("trap:"):
        blockers = _busy_resources(timeline, [trap_resource], window_start, window_end)
        if blockers:
            return "trap_busy", blockers
    return "scheduler_gap_unknown", []


def _busy_resources(timeline, resources, start, end):
    blockers = []
    for resource in resources:
        for interval in timeline.get(resource, []):
            if interval["end"] <= start or end <= interval["start"]:
                continue
            blockers.append(resource)
            break
    return sorted(set(blockers))


def _top_resource_hotspots(timeline, limit=10):
    rows = []
    for resource, intervals in timeline.items():
        duration = sum(max(0, interval["end"] - interval["start"]) for interval in intervals)
        rows.append(
            {
                "resource": resource,
                "duration": duration,
                "count": len(intervals),
                "event_ids": [interval["event_id"] for interval in intervals],
            }
        )
    return sorted(rows, key=lambda item: (-item["duration"], -item["count"], item["resource"]))[:limit]


def _event_resources(event, topology):
    event_type = event.get("type")
    resources = []
    target = event.get("target")
    source = event.get("source")
    if event_type == "gate":
        if _is_location(target):
            resources.append(target)
    elif event_type == "split":
        if _is_location(source):
            resources.append(source)
        if _is_location(target):
            resources.append(target)
    elif event_type == "merge":
        if _is_location(source):
            resources.append(source)
        if _is_location(target):
            resources.append(target)
    elif event_type == "move":
        if _is_location(source):
            resources.append(source)
        if _is_location(target):
            resources.append(target)
        resources.extend(_event_junction_resources(event, topology))
    resources.extend(f"ion:{ion}" for ion in event.get("ions") or [])
    return sorted(set(resources))


def _event_junction_resources(event, topology):
    if event.get("type") != "move":
        return []
    source = event.get("source")
    target = event.get("target")
    if not (_is_segment(source) and _is_segment(target)):
        return []
    segment_endpoints = _segment_endpoint_map(topology)
    shared = set(segment_endpoints.get(source, [])) & set(segment_endpoints.get(target, []))
    return sorted(location for location in shared if isinstance(location, str) and location.startswith("junction:"))


def _segment_endpoint_map(topology):
    endpoints = {}
    if not isinstance(topology, dict):
        return endpoints
    for segment in topology.get("segments") or []:
        if not isinstance(segment, dict):
            continue
        endpoints[f"segment:{segment.get('id')}"] = [segment.get("from"), segment.get("to")]
    return endpoints


def _interval(event):
    start = _number(event.get("start"))
    end = _number(event.get("end"))
    if end < start:
        end = start
    return {
        "event_id": event.get("id"),
        "type": event.get("type"),
        "start": start,
        "end": end,
        "duration": end - start,
    }


def _gate_events_by_id(trace):
    result = {}
    for event in _events(trace):
        if event.get("type") != "gate":
            continue
        gate_id = _integer((event.get("metadata") or {}).get("gate_id"))
        if gate_id is not None:
            result[gate_id] = event
    return result


def _dag_nodes(trace):
    dag = trace.get("dag") if isinstance(trace, dict) else {}
    result = {}
    for node in (dag or {}).get("nodes") or []:
        if not isinstance(node, dict):
            continue
        node_id = _integer(node.get("id"))
        if node_id is not None:
            result[node_id] = node
    return result


def _predecessors(trace):
    dag = trace.get("dag") if isinstance(trace, dict) else {}
    result = defaultdict(list)
    for edge in (dag or {}).get("edges") or []:
        if not isinstance(edge, dict):
            continue
        source = _integer(edge.get("source"))
        target = _integer(edge.get("target"))
        if source is not None and target is not None:
            result[target].append(source)
    return result


def _events(trace):
    events = trace.get("events") if isinstance(trace, dict) else []
    return [event for event in events or [] if isinstance(event, dict)]


def _event_sort_key(event):
    return (_number(event.get("start")), _integer(event.get("id")) or 0)


def _is_location(value):
    return isinstance(value, str) and ":" in value


def _is_segment(value):
    return isinstance(value, str) and value.startswith("segment:")


def _number(value, default=0):
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return default
    if numeric != numeric:
        return default
    if numeric.is_integer():
        return int(numeric)
    return numeric


def _integer(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
