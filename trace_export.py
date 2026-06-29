import json
from pathlib import Path

from machine import Junction, Trap
from schedule import Schedule
from simulation import SCHEDULER_POLICIES, effective_scheduler_flags


def location_key(kind, idx):
    return f"{kind}:{idx}"


def export_trace(result):
    trace = {
        "schema_version": "1.0",
        "device_type": "ion_trap",
        "run": _run_config(result),
        "topology": _topology(result.machine, result.config.machine),
        "dag": _dag(result.parser),
        "particles": _particles(result.initial_layout),
        "events": [_event_to_trace(event, result.machine) for event in result.scheduler.schedule.events],
        "metrics": _metrics(result.scheduler.schedule),
    }
    trace["validation"] = validate_trace(trace)
    return trace


def write_trace(trace, output_path):
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(trace, indent=2), encoding="utf-8")
    return output_path


def validate_trace(trace):
    locations = {particle["id"]: particle["initial_location"] for particle in trace["particles"]}
    busy_until = {}
    trap_busy_until = {}
    pending_transfers = []
    errors = []
    known_locations = _validate_topology(trace.get("topology", {}), errors)
    _validate_initial_particles(trace.get("particles", []), trace.get("topology", {}), known_locations, errors)
    trap_segment_orientation = _trap_segment_orientation(trace.get("topology", {}))
    expected_events = trace.get("metrics", {}).get("event_count")
    if expected_events is not None and expected_events != len(trace["events"]):
        errors.append(f"metrics event_count {expected_events} does not match {len(trace['events'])} events")

    def apply_completed_transfers(time):
        remaining = []
        for transfer in pending_transfers:
            if transfer["end"] <= time:
                locations[transfer["ion"]] = transfer["target"]
            else:
                remaining.append(transfer)
        pending_transfers[:] = remaining

    for event in sorted(trace["events"], key=lambda item: (item["start"], item["id"])):
        apply_completed_transfers(event["start"])
        target = event["target"]
        source = event["source"]
        if source not in known_locations:
            errors.append(f"event {event['id']} unknown source {source}")
        if target not in known_locations:
            errors.append(f"event {event['id']} unknown target {target}")
        _validate_event_endpoint(event, trap_segment_orientation, errors)
        if event["end"] < event["start"]:
            errors.append(f"event {event['id']} ends before it starts")
        trap_location = _event_trap_resource(event)
        if trap_location and trap_busy_until.get(trap_location, 0) > event["start"]:
            errors.append(f"{trap_location} busy until {trap_busy_until[trap_location]} for event {event['id']}")
        for ion in event["ions"]:
            if busy_until.get(ion, 0) > event["start"]:
                errors.append(f"ion {ion} busy until {busy_until[ion]} for event {event['id']}")
            current = locations.get(ion)
            if event["type"] == "gate":
                if current != target:
                    errors.append(f"ion {ion} not at {target} for gate {event['id']}; current={current}")
            elif current != source:
                errors.append(f"ion {ion} not at {source} for {event['type']} {event['id']}; current={current}")
            if event["type"] != "gate":
                pending_transfers.append({"end": event["end"], "ion": ion, "target": target})
            busy_until[ion] = max(busy_until.get(ion, 0), event["end"])
        if trap_location:
            trap_busy_until[trap_location] = max(trap_busy_until.get(trap_location, 0), event["end"])
    apply_completed_transfers(float("inf"))
    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "final_locations": {str(key): value for key, value in sorted(locations.items())},
        "event_count_match": expected_events == len(trace["events"]),
    }


def _validate_topology(topology, errors):
    known_locations = set()
    trap_ids = set()
    junction_ids = set()
    segment_ids = set()

    for trap in topology.get("traps", []):
        trap_id = trap.get("id")
        if trap_id in trap_ids:
            errors.append(f"duplicate trap id {trap_id}")
        trap_ids.add(trap_id)
        known_locations.add(location_key("trap", trap_id))

    for junction in topology.get("junctions", []):
        junction_id = junction.get("id")
        if junction_id in junction_ids:
            errors.append(f"duplicate junction id {junction_id}")
        junction_ids.add(junction_id)
        known_locations.add(location_key("junction", junction_id))

    for segment in topology.get("segments", []):
        segment_id = segment.get("id")
        if segment_id in segment_ids:
            errors.append(f"duplicate segment id {segment_id}")
        segment_ids.add(segment_id)
        for endpoint_key in ("from", "to"):
            endpoint = segment.get(endpoint_key)
            if endpoint not in known_locations:
                errors.append(f"segment {segment_id} unknown {endpoint_key} {endpoint}")
        known_locations.add(location_key("segment", segment_id))

    return known_locations


def _validate_initial_particles(particles, topology, known_locations, errors):
    particle_ids = set()
    trap_capacity = {
        location_key("trap", trap.get("id")): trap.get("capacity")
        for trap in topology.get("traps", [])
        if trap.get("capacity") is not None
    }
    occupancy = {}

    for particle in particles:
        particle_id = particle.get("id")
        if particle_id in particle_ids:
            errors.append(f"duplicate particle id {particle_id}")
        particle_ids.add(particle_id)
        location = particle.get("initial_location")
        if location not in known_locations:
            errors.append(f"particle {particle_id} unknown initial_location {location}")
        if location in trap_capacity:
            occupancy[location] = occupancy.get(location, 0) + 1

    for location, count in sorted(occupancy.items()):
        capacity = trap_capacity[location]
        if count > capacity:
            errors.append(f"{location} initial occupancy {count} exceeds capacity {capacity}")


def _trap_segment_orientation(topology):
    orientation = {}
    for trap in topology.get("traps", []):
        trap_location = location_key("trap", trap.get("id"))
        for segment_id, side in (trap.get("orientation") or {}).items():
            orientation[(trap_location, location_key("segment", int(segment_id)))] = side
    return orientation


def _validate_event_endpoint(event, trap_segment_orientation, errors):
    event_type = event.get("type")
    if event_type == "split":
        trap_location = event.get("source")
        segment_location = event.get("target")
    elif event_type == "merge":
        trap_location = event.get("target")
        segment_location = event.get("source")
    else:
        return

    expected = trap_segment_orientation.get((trap_location, segment_location))
    if expected is None:
        return
    actual = (event.get("metadata") or {}).get("endpoint")
    if actual != expected:
        errors.append(
            f"event {event.get('id')} endpoint {actual} does not match "
            f"{trap_location} {segment_location} orientation {expected}"
        )


def _event_trap_resource(event):
    event_type = event.get("type")
    if event_type == "gate" and str(event.get("target", "")).startswith("trap:"):
        return event["target"]
    if event_type == "split" and str(event.get("source", "")).startswith("trap:"):
        return event["source"]
    if event_type == "merge" and str(event.get("target", "")).startswith("trap:"):
        return event["target"]
    return None


def _run_config(result):
    config = result.config
    serial_trap_ops, serial_comm, serial_all = effective_scheduler_flags(config)
    return {
        "program": config.program,
        "machine": config.machine,
        "ions_per_region": config.ions,
        "mapper": config.mapper,
        "reorder": config.reorder,
        "scheduler_policy": config.scheduler_policy or _scheduler_policy_name(serial_trap_ops, serial_comm, serial_all),
        "serial_trap_ops": serial_trap_ops,
        "serial_comm": serial_comm,
        "serial_all": serial_all,
        "gate_type": config.gate_type,
        "swap_type": config.swap_type,
        "single_qubit_gate_time": config.single_qubit_gate_time,
        "single_qubit_gate_fidelity": config.single_qubit_gate_fidelity,
    }


def _scheduler_policy_name(serial_trap_ops, serial_comm, serial_all):
    for policy, values in SCHEDULER_POLICIES.items():
        if (
            values["serial_trap_ops"] == serial_trap_ops
            and values["serial_comm"] == serial_comm
            and values["serial_all"] == serial_all
        ):
            return policy
    return "Custom"


def _topology(machine, machine_name):
    segments = []
    for u, v, data in machine.graph.edges(data=True):
        segment = data["seg"]
        segments.append({"id": segment.id, "from": _object_location(u), "to": _object_location(v), "length": segment.length})
    return {
        "traps": [
            {
                "id": trap.id,
                "capacity": trap.capacity,
                "slots": list(range(trap.capacity)),
                "orientation": {str(seg_id): side for seg_id, side in sorted(trap.orientation.items())},
            }
            for trap in machine.traps
        ],
        "segments": sorted(segments, key=lambda item: item["id"]),
        "junctions": [_junction_to_trace(machine, junction) for junction in machine.junctions],
        "layout": _layout(machine, machine_name),
    }


def _junction_to_trace(machine, junction):
    degree = machine.graph.degree(junction)
    return {
        "id": junction.id,
        "degree": degree,
        "junction_type": f"J{degree}",
        "cross_time": machine.junction_cross_time(junction),
    }


def _layout(machine, machine_name):
    if machine_name == "L6":
        return _linear_layout(machine)
    if machine_name in {"T4x2", "T6x3", "T8x4", "G2x3"}:
        return _paired_trap_layout(machine)
    if machine_name in {"G3x3", "G9"}:
        return _grid_layout(machine)
    if machine_name == "H6":
        return _circle_layout(machine)
    return _linear_layout(machine)


def _linear_layout(machine):
    layout = {}
    for trap in machine.traps:
        layout[location_key("trap", trap.id)] = {"x": trap.id, "y": 1.0}
    for junction in machine.junctions:
        layout[location_key("junction", junction.id)] = {"x": junction.id + 0.5, "y": 0.0}
    return layout


def _paired_trap_layout(machine):
    layout = {}
    junction_count = max(1, len(machine.junctions))
    for junction in machine.junctions:
        layout[location_key("junction", junction.id)] = {"x": junction.id, "y": 1.0}
    for trap in machine.traps:
        connected_junctions = [
            obj for obj in machine.graph.neighbors(trap) if isinstance(obj, Junction)
        ]
        x = connected_junctions[0].id if connected_junctions else trap.id % junction_count
        y = 0.0 if trap.id < junction_count else 2.0
        layout[location_key("trap", trap.id)] = {"x": x, "y": y}
    return layout


def _grid_layout(machine):
    layout = {}
    trap_columns = 3
    for trap in machine.traps:
        layout[location_key("trap", trap.id)] = {"x": trap.id % trap_columns, "y": trap.id // trap_columns}
    for junction in machine.junctions:
        if len(machine.junctions) == 6:
            row = 0.5 if junction.id < 3 else 1.5
            col = junction.id % 3
        else:
            row = junction.id // 3
            col = junction.id % 3
        layout[location_key("junction", junction.id)] = {"x": col, "y": row}
    return layout


def _circle_layout(machine):
    import math

    layout = {}
    trap_count = max(1, len(machine.traps))
    junction_count = max(1, len(machine.junctions))
    for trap in machine.traps:
        angle = (2 * math.pi * trap.id) / trap_count
        layout[location_key("trap", trap.id)] = {"x": 1.0 + math.cos(angle), "y": 1.0 + math.sin(angle)}
    for junction in machine.junctions:
        angle = (2 * math.pi * (junction.id + 0.5)) / junction_count
        layout[location_key("junction", junction.id)] = {"x": 1.0 + 0.55 * math.cos(angle), "y": 1.0 + 0.55 * math.sin(angle)}
    return layout


def _object_location(obj):
    if isinstance(obj, Trap):
        return location_key("trap", obj.id)
    if isinstance(obj, Junction):
        return location_key("junction", obj.id)
    raise TypeError("Unsupported topology object: " + repr(obj))


def _dag(parser):
    nodes = []
    for gate_id in sorted(parser.gate_graph.nodes):
        qubits = list(parser.gate_qubit_map.get(gate_id, []))
        nodes.append(
            {
                "id": gate_id,
                "gate_name": parser.gate_name_map.get(gate_id),
                "qubits": qubits,
                "arity": len(qubits),
            }
        )
    return {
        "nodes": nodes,
        "edges": [
            {"source": source, "target": target}
            for source, target in sorted(parser.gate_graph.edges())
        ],
    }


def _particles(initial_layout):
    particles = []
    for trap_id, ions in sorted(initial_layout.items()):
        for slot, ion in enumerate(ions):
            particles.append({"id": ion, "initial_location": location_key("trap", trap_id), "initial_slot": slot})
    return sorted(particles, key=lambda item: item["id"])


def _event_to_trace(event, machine):
    event_id, event_type, start, end, info = event
    if event_type == Schedule.Gate:
        event_name = "gate"
        source = target = location_key("trap", info["trap"])
    elif event_type == Schedule.Split:
        event_name = "split"
        source = location_key("trap", info["trap"])
        target = location_key("segment", info["seg"])
    elif event_type == Schedule.Move:
        event_name = "move"
        source = location_key("segment", info["source_seg"])
        target = location_key("segment", info["dest_seg"])
    elif event_type == Schedule.Merge:
        event_name = "merge"
        source = location_key("segment", info["seg"])
        target = location_key("trap", info["trap"])
    else:
        raise ValueError("Unsupported schedule event type: " + str(event_type))
    return {
        "id": event_id,
        "type": event_name,
        "start": start,
        "end": end,
        "ions": list(info["ions"]),
        "source": source,
        "target": target,
        "metadata": {
            "gate_id": info.get("gate_id"),
            "gate_name": info.get("gate_name"),
            "arity": info.get("arity"),
            "swap_count": info.get("swap_cnt", 0),
            "swap_hops": info.get("swap_hops", 0),
            "ion_hops": info.get("ion_hops", 0),
            "endpoint": _event_endpoint(event_type, info, machine),
            "swap_ions": [info.get("i1"), info.get("i2")] if info.get("i1") != info.get("i2") else [],
        },
    }


def _event_endpoint(event_type, info, machine):
    if event_type not in {Schedule.Split, Schedule.Merge}:
        return None
    trap = next((item for item in machine.traps if item.id == info["trap"]), None)
    if trap is None:
        return None
    return trap.orientation.get(info["seg"])


def _metrics(schedule):
    events = list(schedule.events)
    by_type = {"gate": 0, "split": 0, "move": 0, "merge": 0}
    time_by_type = {"gate": 0, "split": 0, "move": 0, "merge": 0}
    one_q = 0
    two_q = 0
    swap_count = 0
    swap_hops = 0
    ion_hops = 0
    for event in events:
        event_type = event[1]
        duration = event[3] - event[2]
        if event_type == Schedule.Gate:
            by_type["gate"] += 1
            time_by_type["gate"] += duration
            if event[4].get("arity", len(event[4]["ions"])) == 1:
                one_q += 1
            else:
                two_q += 1
        elif event_type == Schedule.Split:
            by_type["split"] += 1
            time_by_type["split"] += duration
            swap_count += int(event[4].get("swap_cnt", 0) or 0)
            swap_hops += int(event[4].get("swap_hops", 0) or 0)
            ion_hops += int(event[4].get("ion_hops", 0) or 0)
        elif event_type == Schedule.Move:
            by_type["move"] += 1
            time_by_type["move"] += duration
        elif event_type == Schedule.Merge:
            by_type["merge"] += 1
            time_by_type["merge"] += duration
    parallel = _gate_parallel_metrics(events)
    return {
        "event_count": len(events),
        "finish_time": max((event[3] for event in events), default=0),
        "counts": by_type,
        "times": time_by_type,
        "one_qubit_gates": one_q,
        "two_qubit_gates": two_q,
        "shuttling_time": time_by_type["split"] + time_by_type["move"] + time_by_type["merge"],
        "swap_count": swap_count,
        "swap_hops": swap_hops,
        "ion_hops": ion_hops,
        **parallel,
    }


def _gate_parallel_metrics(events):
    gates = [event for event in events if event[1] == Schedule.Gate]
    max_parallel = 0
    cross_trap_parallel = 0
    same_trap_overlaps = 0

    for index, left in enumerate(gates):
        active_at_start = [
            gate
            for gate in gates
            if gate[2] <= left[2] < gate[3]
        ]
        max_parallel = max(max_parallel, len(active_at_start))
        if len({gate[4]["trap"] for gate in active_at_start}) > 1:
            cross_trap_parallel += 1

        for right in gates[index + 1 :]:
            if left[4]["trap"] != right[4]["trap"]:
                continue
            if left[2] < right[3] and right[2] < left[3]:
                same_trap_overlaps += 1

    return {
        "max_parallel_gates": max_parallel,
        "cross_trap_parallel_gates": cross_trap_parallel,
        "same_trap_gate_overlaps": same_trap_overlaps,
    }
