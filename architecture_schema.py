"""Validation and normalization for custom QCCD architecture specs."""

from __future__ import annotations

import math
from collections import Counter


SUPPORTED_SCHEMA_VERSION = "qccd_architecture_v1"
SUPPORTED_DEVICE_TYPE = "ion_trap_qccd"
SUPPORTED_TRAP_PORT_SIDES = {"L", "R"}
SUPPORTED_JUNCTION_DEGREES = {2, 3, 4}


class ArchitectureValidationError(ValueError):
    def __init__(self, details):
        self.details = list(details)
        super().__init__("Invalid QCCD architecture specification")


def validate_architecture_spec(spec):
    errors = []
    if not isinstance(spec, dict):
        raise ArchitectureValidationError(["architecture spec must be an object"])

    schema_version = spec.get("schema_version")
    if schema_version != SUPPORTED_SCHEMA_VERSION:
        errors.append(f"schema_version must be {SUPPORTED_SCHEMA_VERSION}")

    device_type = spec.get("device_type", SUPPORTED_DEVICE_TYPE)
    if device_type != SUPPORTED_DEVICE_TYPE:
        errors.append(f"device_type must be {SUPPORTED_DEVICE_TYPE}")

    defaults = spec.get("defaults") or {}
    if not isinstance(defaults, dict):
        errors.append("defaults must be an object")
        defaults = {}

    traps = _require_records(spec, "traps", errors)
    junctions = _require_records(spec, "junctions", errors)
    segments = _require_records(spec, "segments", errors)

    trap_records = _normalize_traps(traps, errors)
    junction_records = _normalize_junctions(junctions, errors)
    segment_records = _normalize_segments(segments, defaults, errors)

    trap_by_id = {trap["id"]: trap for trap in trap_records}
    junction_by_id = {junction["id"]: junction for junction in junction_records}
    segment_by_id = {segment["id"]: segment for segment in segment_records}

    _validate_dense_trap_ids(trap_records, errors)
    _validate_endpoint_references(segment_records, trap_by_id, junction_by_id, errors)
    _validate_graph_edges(segment_records, errors)
    _validate_connected_graph(trap_records, junction_records, segment_records, errors)
    trap_orientation = _validate_trap_ports(trap_records, segment_by_id, errors)
    junction_degrees = _validate_junction_degrees(junction_records, segment_records, errors)
    layout = _normalize_layout(spec.get("layout"), trap_records, junction_records, errors)

    if errors:
        raise ArchitectureValidationError(errors)

    normalized_traps = []
    for trap in sorted(trap_records, key=lambda item: item["id"]):
        capacity = trap["capacity"]
        orientation = trap_orientation.get(trap["id"], {})
        normalized_traps.append(
            {
                "id": trap["id"],
                "capacity": capacity,
                "physical_capacity": capacity,
                "initial_ion_capacity": capacity,
                "communication_buffer": trap["communication_buffer"],
                "slots": list(range(capacity)),
                "orientation": {str(segment_id): side for segment_id, side in sorted(orientation.items())},
                "gate_zone": trap["gate_zone"],
                "storage_zones": trap["storage_zones"],
                "laser_accessible": trap["laser_accessible"],
            }
        )

    normalized_segments = [
        {
            "id": segment["id"],
            "from": segment["from"],
            "to": segment["to"],
            "length": segment["length"],
            "capacity": segment["capacity"],
        }
        for segment in sorted(segment_records, key=lambda item: item["id"])
    ]

    normalized_junctions = []
    for junction in sorted(junction_records, key=lambda item: item["id"]):
        normalized_junctions.append(
            {
                "id": junction["id"],
                "degree": junction_degrees[junction["id"]],
                "kind": junction["kind"],
                "cross_time": junction["cross_time"],
            }
        )

    return {
        "valid": True,
        "schema_version": SUPPORTED_SCHEMA_VERSION,
        "device_type": SUPPORTED_DEVICE_TYPE,
        "id": str(spec.get("id") or "custom_qccd_architecture"),
        "name": str(spec.get("name") or spec.get("id") or "Custom QCCD architecture"),
        "status": "graph_valid",
        "scheduling_support": "qccdsim_machine_builder",
        "warnings": [],
        "topology": {
            "traps": normalized_traps,
            "segments": normalized_segments,
            "junctions": normalized_junctions,
            "layout": layout,
        },
    }


def _require_records(spec, key, errors):
    value = spec.get(key)
    if not isinstance(value, list) or not value:
        errors.append(f"{key} must be a non-empty list")
        return []
    records = []
    for index, item in enumerate(value):
        if isinstance(item, dict):
            records.append(item)
        else:
            errors.append(f"{key}[{index}] must be an object")
    return records


def _normalize_traps(traps, errors):
    records = []
    ids = []
    for trap in traps:
        trap_id = _int_id(trap.get("id"))
        if trap_id is None:
            errors.append(f"trap id {trap.get('id')} must be an integer")
            continue
        ids.append(trap_id)
        capacity = _positive_int(trap.get("capacity"))
        if capacity is None:
            errors.append(f"trap {trap_id} capacity must be a positive integer")
            capacity = 1
        communication_buffer = _nonnegative_int(trap.get("communication_buffer", 0))
        if communication_buffer is None:
            errors.append(f"trap {trap_id} communication_buffer must be a non-negative integer")
            communication_buffer = 0
        storage_zones = trap.get("storage_zones")
        if storage_zones is None:
            storage_zones = list(range(capacity))
        elif not _is_int_list(storage_zones):
            errors.append(f"trap {trap_id} storage_zones must be a list of integer slot ids")
            storage_zones = list(range(capacity))
        records.append(
            {
                "id": trap_id,
                "capacity": capacity,
                "ports": trap.get("ports", []),
                "gate_zone": bool(trap.get("gate_zone", True)),
                "storage_zones": storage_zones,
                "laser_accessible": bool(trap.get("laser_accessible", True)),
                "communication_buffer": communication_buffer,
            }
        )
    for duplicate in _duplicates(ids):
        errors.append(f"duplicate trap id {duplicate}")
    return records


def _normalize_junctions(junctions, errors):
    records = []
    ids = []
    for junction in junctions:
        junction_id = _int_id(junction.get("id"))
        if junction_id is None:
            errors.append(f"junction id {junction.get('id')} must be an integer")
            continue
        ids.append(junction_id)
        declared_degree = junction.get("degree")
        if declared_degree is not None and _positive_int(declared_degree) is None:
            errors.append(f"junction {junction_id} degree must be a positive integer")
            declared_degree = None
        cross_time = _positive_int(junction.get("cross_time", _default_junction_cross_time(declared_degree)))
        if cross_time is None:
            errors.append(f"junction {junction_id} cross_time must be a positive integer")
            cross_time = _default_junction_cross_time(declared_degree)
        records.append(
            {
                "id": junction_id,
                "degree": int(declared_degree) if declared_degree is not None else None,
                "kind": str(junction.get("kind") or "junction"),
                "cross_time": cross_time,
            }
        )
    for duplicate in _duplicates(ids):
        errors.append(f"duplicate junction id {duplicate}")
    return records


def _normalize_segments(segments, defaults, errors):
    records = []
    ids = []
    default_capacity = _positive_int(defaults.get("segment_capacity", 16)) or 16
    default_length = _positive_int(defaults.get("segment_length", 10)) or 10
    for segment in segments:
        segment_id = _int_id(segment.get("id"))
        if segment_id is None:
            errors.append(f"segment id {segment.get('id')} must be an integer")
            continue
        ids.append(segment_id)
        length = _positive_int(segment.get("length", default_length))
        if length is None:
            errors.append(f"segment {segment_id} length must be a positive integer")
            length = default_length
        capacity = _positive_int(segment.get("capacity", default_capacity))
        if capacity is None:
            errors.append(f"segment {segment_id} capacity must be a positive integer")
            capacity = default_capacity
        source = _normalize_endpoint(segment.get("from"), f"segment {segment_id} from", errors)
        target = _normalize_endpoint(segment.get("to"), f"segment {segment_id} to", errors)
        records.append(
            {
                "id": segment_id,
                "from": source,
                "to": target,
                "length": length,
                "capacity": capacity,
            }
        )
    for duplicate in _duplicates(ids):
        errors.append(f"duplicate segment id {duplicate}")
    return records


def _normalize_endpoint(endpoint, label, errors):
    if isinstance(endpoint, str):
        kind, _, raw_id = endpoint.partition(":")
        endpoint_id = _int_id(raw_id)
    elif isinstance(endpoint, dict):
        kind = endpoint.get("type")
        endpoint_id = _int_id(endpoint.get("id"))
    else:
        errors.append(f"{label} endpoint must be a trap or junction reference")
        return None
    if kind not in {"trap", "junction"} or endpoint_id is None:
        errors.append(f"{label} endpoint must be trap:<id> or junction:<id>")
        return None
    return f"{kind}:{endpoint_id}"


def _validate_endpoint_references(segments, trap_by_id, junction_by_id, errors):
    for segment in segments:
        for endpoint_key in ("from", "to"):
            endpoint = segment[endpoint_key]
            if endpoint is None:
                continue
            kind, raw_id = endpoint.split(":", 1)
            endpoint_id = int(raw_id)
            if kind == "trap" and endpoint_id not in trap_by_id:
                errors.append(f"segment {segment['id']} references unknown trap {endpoint_id}")
            if kind == "junction" and endpoint_id not in junction_by_id:
                errors.append(f"segment {segment['id']} references unknown junction {endpoint_id}")
        endpoint_kinds = {str(segment.get("from", "")).split(":", 1)[0], str(segment.get("to", "")).split(":", 1)[0]}
        if endpoint_kinds == {"trap"}:
            errors.append(f"segment {segment['id']} must connect a trap to a junction or two junctions")


def _validate_dense_trap_ids(traps, errors):
    ids = sorted(trap["id"] for trap in traps)
    expected = list(range(len(ids)))
    if ids and ids != expected:
        errors.append(f"trap ids must be dense zero-based integers: expected {expected}, got {ids}")


def _validate_graph_edges(segments, errors):
    endpoint_pairs = {}
    for segment in segments:
        source = segment.get("from")
        target = segment.get("to")
        if not source or not target:
            continue
        if source == target:
            errors.append(f"segment {segment['id']} must not connect a node to itself")
            continue
        key = tuple(sorted((source, target), key=_endpoint_sort_key))
        if key in endpoint_pairs:
            errors.append(f"segment {segment['id']} duplicates endpoint pair {key[0]} -- {key[1]}")
            continue
        endpoint_pairs[key] = segment["id"]


def _validate_connected_graph(traps, junctions, segments, errors):
    nodes = {f"trap:{trap['id']}" for trap in traps}
    nodes.update(f"junction:{junction['id']}" for junction in junctions)
    if not nodes:
        return
    adjacency = {node: set() for node in nodes}
    for segment in segments:
        source = segment.get("from")
        target = segment.get("to")
        if source not in nodes or target not in nodes or source == target:
            continue
        adjacency[source].add(target)
        adjacency[target].add(source)
    start = next(iter(nodes))
    visited = {start}
    queue = [start]
    while queue:
        node = queue.pop(0)
        for neighbor in adjacency.get(node, set()):
            if neighbor in visited:
                continue
            visited.add(neighbor)
            queue.append(neighbor)
    if visited != nodes:
        errors.append("architecture graph must be connected")


def _validate_trap_ports(traps, segment_by_id, errors):
    orientation_by_trap = {}
    segment_endpoints = {
        segment["id"]: {segment["from"], segment["to"]}
        for segment in segment_by_id.values()
        if segment.get("from") and segment.get("to")
    }
    declared_ports = {}
    for trap in traps:
        ports = trap.get("ports")
        if not isinstance(ports, list):
            errors.append(f"trap {trap['id']} ports must be a list")
            ports = []
        orientation = {}
        for port in ports:
            if not isinstance(port, dict):
                errors.append(f"trap {trap['id']} port must be an object")
                continue
            segment_id = _int_id(port.get("segment"))
            if segment_id is None:
                errors.append(f"trap {trap['id']} port segment must be an integer")
                continue
            side = port.get("side")
            if side not in SUPPORTED_TRAP_PORT_SIDES:
                errors.append(f"trap {trap['id']} port for segment {segment_id} must use chain endpoint side L or R")
                continue
            if segment_id not in segment_by_id:
                errors.append(f"trap {trap['id']} port references unknown segment {segment_id}")
                continue
            trap_location = f"trap:{trap['id']}"
            if trap_location not in segment_endpoints.get(segment_id, set()):
                errors.append(f"trap {trap['id']} port segment {segment_id} is not incident to trap {trap['id']}")
                continue
            if segment_id in orientation:
                errors.append(f"trap {trap['id']} declares duplicate port for segment {segment_id}")
                continue
            orientation[segment_id] = side
            declared_ports[(trap["id"], segment_id)] = side
        orientation_by_trap[trap["id"]] = orientation

    for segment in segment_by_id.values():
        endpoints = {segment.get("from"), segment.get("to")}
        for endpoint in endpoints:
            if not str(endpoint).startswith("trap:"):
                continue
            trap_id = int(endpoint.split(":", 1)[1])
            if (trap_id, segment["id"]) not in declared_ports:
                errors.append(f"trap {trap_id} segment {segment['id']} is missing a trap port side")
    return orientation_by_trap


def _validate_junction_degrees(junctions, segments, errors):
    degrees = {junction["id"]: 0 for junction in junctions}
    for segment in segments:
        for endpoint in (segment.get("from"), segment.get("to")):
            if str(endpoint).startswith("junction:"):
                junction_id = int(endpoint.split(":", 1)[1])
                if junction_id in degrees:
                    degrees[junction_id] += 1
    for junction in junctions:
        actual = degrees[junction["id"]]
        declared = junction.get("degree")
        if declared is not None and declared != actual:
            errors.append(f"junction {junction['id']} declared degree {declared} but graph degree is {actual}")
        if actual not in SUPPORTED_JUNCTION_DEGREES:
            errors.append(
                f"junction {junction['id']} graph degree {actual} is unsupported; supported degrees are 2, 3, and 4"
            )
    return degrees


def _normalize_layout(layout, traps, junctions, errors):
    locations = [f"trap:{trap['id']}" for trap in sorted(traps, key=lambda item: item["id"])]
    locations.extend(f"junction:{junction['id']}" for junction in sorted(junctions, key=lambda item: item["id"]))
    if layout is None:
        return _generated_layout(locations)
    if not isinstance(layout, dict):
        errors.append("layout must be an object when provided")
        return {}
    normalized = {}
    for location in locations:
        point = layout.get(location)
        if point is None:
            continue
        if not isinstance(point, dict) or not _is_number(point.get("x")) or not _is_number(point.get("y")):
            errors.append(f"layout.{location} must include numeric x and y")
            continue
        normalized_point = {"x": float(point["x"]), "y": float(point["y"])}
        if _is_number(point.get("angle")):
            normalized_point["angle"] = float(point["angle"])
        normalized[location] = normalized_point
    missing = [location for location in locations if location not in normalized]
    if missing:
        generated = _generated_layout(missing)
        normalized.update(generated)
    return normalized


def _generated_layout(locations):
    traps = [location for location in locations if location.startswith("trap:")]
    junctions = [location for location in locations if location.startswith("junction:")]
    layout = {}
    radius = max(1.0, len(traps) / math.pi)
    for index, location in enumerate(traps):
        angle = (2 * math.pi * index) / max(1, len(traps))
        layout[location] = {
            "x": round(radius * math.cos(angle), 6),
            "y": round(radius * math.sin(angle), 6),
            "angle": round(angle + math.pi / 2, 6),
        }
    for index, location in enumerate(junctions):
        layout[location] = {"x": round(index * 0.25, 6), "y": 0.0}
    return layout


def _int_id(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdecimal():
        return int(value)
    return None


def _positive_int(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value > 0:
        return value
    return None


def _nonnegative_int(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value >= 0:
        return value
    return None


def _is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _is_int_list(value):
    return isinstance(value, list) and all(isinstance(item, int) and not isinstance(item, bool) for item in value)


def _duplicates(values):
    return [value for value, count in Counter(values).items() if count > 1]


def _default_junction_cross_time(degree):
    if degree == 3:
        return 100
    if degree == 4:
        return 120
    return 5


def _endpoint_sort_key(location):
    kind, _, raw_id = str(location).partition(":")
    rank = {"trap": 0, "junction": 1}.get(kind, 2)
    try:
        item_id = int(raw_id)
    except ValueError:
        item_id = 0
    return rank, item_id
