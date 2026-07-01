from trace_contract import validate_trace_contract


EVENT_TYPES = ("gate", "split", "move", "merge")


def build_trace_validation(trace):
    contract = validate_trace_contract(trace)
    physics = validate_trace_physics(trace)
    dag = validate_trace_dag(trace)
    metrics = validate_trace_metrics(trace)
    errors = _unique_errors(contract["errors"] + physics["errors"] + dag["errors"] + metrics["errors"])
    return {
        "valid": contract["valid"] and physics["valid"] and dag["valid"] and metrics["valid"],
        "errors": errors,
        "contract": contract,
        "physics": physics,
        "dag": dag,
        "metrics": metrics,
        "final_locations": physics.get("final_locations", {}),
        "event_count_match": physics.get("event_count_match", metrics.get("event_count_match", False)),
    }


def validate_trace_physics(trace):
    from trace_export import validate_trace

    return validate_trace(trace)


def validate_trace_dag(trace):
    errors = []
    dag = trace.get("dag") if isinstance(trace, dict) else None
    events = trace.get("events") if isinstance(trace, dict) else None
    if not isinstance(dag, dict):
        return {"valid": False, "errors": ["dag must be an object"]}
    if not isinstance(events, list):
        return {"valid": False, "errors": ["events must be a list"]}

    nodes = dag.get("nodes", [])
    edges = dag.get("edges", [])
    if not isinstance(nodes, list):
        errors.append("dag.nodes must be a list")
        nodes = []
    if not isinstance(edges, list):
        errors.append("dag.edges must be a list")
        edges = []

    node_ids = {node.get("id") for node in nodes if isinstance(node, dict)}
    gate_events = {}
    for event in events:
        if not isinstance(event, dict) or event.get("type") != "gate":
            continue
        gate_id = (event.get("metadata") or {}).get("gate_id")
        if gate_id not in node_ids:
            errors.append(f"gate event {event.get('id')} references unknown dag node {gate_id}")
            continue
        if gate_id in gate_events:
            errors.append(f"dag node {gate_id} has multiple matching gate events")
            continue
        gate_events[gate_id] = event

    for node_id in sorted(node_ids, key=lambda item: (str(type(item)), str(item))):
        if node_id not in gate_events:
            errors.append(f"dag node {node_id} has no matching gate event")

    for edge in edges:
        if not isinstance(edge, dict):
            errors.append("dag edge must be an object")
            continue
        source = edge.get("source")
        target = edge.get("target")
        source_event = gate_events.get(source)
        target_event = gate_events.get(target)
        if source_event is None or target_event is None:
            continue
        if source_event.get("end", 0) > target_event.get("start", 0):
            errors.append(
                f"dag edge {source}->{target} violates event order: "
                f"source ends at {source_event.get('end')} but target starts at {target_event.get('start')}"
            )

    return {"valid": len(errors) == 0, "errors": errors}


def recompute_trace_metrics(trace):
    events = [event for event in trace.get("events", []) if isinstance(event, dict)]
    counts = {event_type: 0 for event_type in EVENT_TYPES}
    times = {event_type: 0 for event_type in EVENT_TYPES}
    one_qubit_gates = 0
    two_qubit_gates = 0
    swap_count = 0
    swap_hops = 0
    ion_hops = 0

    for event in events:
        event_type = event.get("type")
        if event_type not in counts:
            continue
        duration = event.get("end", 0) - event.get("start", 0)
        counts[event_type] += 1
        times[event_type] += duration
        metadata = event.get("metadata") or {}
        if event_type == "gate":
            arity = metadata.get("arity", len(event.get("ions", []) or []))
            if arity == 1:
                one_qubit_gates += 1
            else:
                two_qubit_gates += 1
        elif event_type == "split":
            swap_count += int(metadata.get("swap_count", 0) or 0)
            swap_hops += int(metadata.get("swap_hops", 0) or 0)
            ion_hops += int(metadata.get("ion_hops", 0) or 0)

    return {
        "event_count": len(events),
        "finish_time": max((event.get("end", 0) for event in events), default=0),
        "counts": counts,
        "times": times,
        "one_qubit_gates": one_qubit_gates,
        "two_qubit_gates": two_qubit_gates,
        "shuttling_time": times["split"] + times["move"] + times["merge"],
        "swap_count": swap_count,
        "swap_hops": swap_hops,
        "ion_hops": ion_hops,
        "bottlenecks": extract_trace_bottlenecks(trace),
        **_gate_parallel_metrics(events),
    }


def extract_trace_bottlenecks(trace, limit=5):
    """Return deterministic resource hot spots derived only from trace events."""
    events = [event for event in trace.get("events", []) if isinstance(event, dict)]
    segment_usage = {}
    junction_usage = {}
    largest_shuttles = []
    topology = trace.get("topology") if isinstance(trace, dict) else {}

    for event in events:
        if event.get("type") not in {"split", "move", "merge"}:
            continue
        event_id = event.get("id")
        duration = max(0, _number(event.get("end")) - _number(event.get("start")))
        segments = _event_segment_resources(event)
        junctions = _event_junction_resources(event, topology)
        for resource in segments:
            _add_resource_usage(segment_usage, resource, duration, event_id)
        for resource in junctions:
            _add_resource_usage(junction_usage, resource, duration, event_id)
        largest_shuttles.append(
            {
                "event_id": event_id,
                "type": event.get("type"),
                "duration": duration,
                "resources": segments + junctions,
                "cost": duration * max(1, len(segments) + len(junctions)),
            }
        )

    return {
        "segments": _rank_resource_usage(segment_usage, limit),
        "junctions": _rank_resource_usage(junction_usage, limit),
        "largest_shuttles": sorted(
            largest_shuttles,
            key=lambda item: (-item["cost"], item["event_id"] if item["event_id"] is not None else -1),
        )[:limit],
        "dag_stalls": _dag_stalls(trace, limit),
    }


def validate_trace_metrics(trace):
    expected = recompute_trace_metrics(trace)
    actual = trace.get("metrics") if isinstance(trace, dict) else None
    if not isinstance(actual, dict):
        return {"valid": False, "errors": ["metrics must be an object"], "recomputed": expected}

    errors = []
    for key, expected_value in expected.items():
        actual_value = actual.get(key)
        if actual_value != expected_value:
            errors.append(f"metrics.{key} expected {expected_value} but found {actual_value}")

    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "recomputed": expected,
        "event_count_match": actual.get("event_count") == expected["event_count"],
    }


def _gate_parallel_metrics(events):
    gates = [event for event in events if event.get("type") == "gate"]
    max_parallel = 0
    cross_trap_parallel = 0
    same_trap_overlaps = 0
    for index, left in enumerate(gates):
        left_start = left.get("start", 0)
        left_end = left.get("end", 0)
        active_at_start = [gate for gate in gates if gate.get("start", 0) <= left_start < gate.get("end", 0)]
        max_parallel = max(max_parallel, len(active_at_start))
        if len({gate.get("target") for gate in active_at_start}) > 1:
            cross_trap_parallel += 1
        for right in gates[index + 1 :]:
            if left.get("target") != right.get("target"):
                continue
            if left_start < right.get("end", 0) and right.get("start", 0) < left_end:
                same_trap_overlaps += 1
    return {
        "max_parallel_gates": max_parallel,
        "cross_trap_parallel_gates": cross_trap_parallel,
        "same_trap_gate_overlaps": same_trap_overlaps,
    }


def _event_segment_resources(event):
    event_type = event.get("type")
    if event_type == "split" and _is_segment(event.get("target")):
        return [event.get("target")]
    if event_type == "merge" and _is_segment(event.get("source")):
        return [event.get("source")]
    if event_type == "move":
        return sorted({location for location in [event.get("source"), event.get("target")] if _is_segment(location)})
    return []


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
        resource = f"segment:{segment.get('id')}"
        endpoints[resource] = [segment.get("from"), segment.get("to")]
    return endpoints


def _add_resource_usage(usage, resource, duration, event_id):
    entry = usage.setdefault(resource, {"resource": resource, "duration": 0, "count": 0, "event_ids": []})
    entry["duration"] += duration
    entry["count"] += 1
    if event_id is not None:
        entry["event_ids"].append(event_id)


def _rank_resource_usage(usage, limit):
    return sorted(
        usage.values(),
        key=lambda item: (-item["duration"], -item["count"], item["resource"]),
    )[:limit]


def _dag_stalls(trace, limit):
    gate_windows = {}
    for event in trace.get("events") or []:
        if not isinstance(event, dict) or event.get("type") != "gate":
            continue
        gate_id = (event.get("metadata") or {}).get("gate_id")
        gate_id = _integer_id(gate_id)
        if gate_id is not None:
            gate_windows[gate_id] = (_number(event.get("start")), _number(event.get("end")))

    stalls = []
    for edge in (trace.get("dag") or {}).get("edges") or []:
        source = _integer_id(edge.get("source"))
        target = _integer_id(edge.get("target"))
        if source is None or target is None:
            continue
        if source not in gate_windows or target not in gate_windows:
            continue
        _, source_end = gate_windows[source]
        target_start, _ = gate_windows[target]
        stall_time = max(0, target_start - source_end)
        if stall_time > 0:
            stalls.append({"source": source, "target": target, "stall_time": stall_time})
    return sorted(stalls, key=lambda item: (-item["stall_time"], item["source"], item["target"]))[:limit]


def _is_segment(location):
    return isinstance(location, str) and location.startswith("segment:")


def _number(value, default=0):
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return default
    return numeric if numeric == numeric else default


def _integer_id(value):
    try:
        numeric = int(value)
    except (TypeError, ValueError):
        return None
    return numeric


def _unique_errors(errors):
    result = []
    seen = set()
    for error in errors:
        if error in seen:
            continue
        result.append(error)
        seen.add(error)
    return result
