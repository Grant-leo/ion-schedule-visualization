import json
from pathlib import Path

from machine import Junction, Trap
from schedule import Schedule


def location_key(kind, idx):
    return f"{kind}:{idx}"


def export_trace(result):
    trace = {
        "schema_version": "1.0",
        "device_type": "ion_trap",
        "run": _run_config(result),
        "topology": _topology(result.machine),
        "particles": _particles(result.initial_layout),
        "events": [_event_to_trace(event) for event in result.scheduler.schedule.events],
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
    pending_transfers = []
    errors = []

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
        if event["end"] < event["start"]:
            errors.append(f"event {event['id']} ends before it starts")
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
    apply_completed_transfers(float("inf"))
    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "final_locations": {str(key): value for key, value in sorted(locations.items())},
        "event_count_match": trace.get("metrics", {}).get("event_count") == len(trace["events"]),
    }


def _run_config(result):
    config = result.config
    return {
        "program": config.program,
        "machine": config.machine,
        "ions_per_region": config.ions,
        "mapper": config.mapper,
        "reorder": config.reorder,
        "serial_trap_ops": config.serial_trap_ops,
        "serial_comm": config.serial_comm,
        "serial_all": config.serial_all,
        "gate_type": config.gate_type,
        "swap_type": config.swap_type,
        "single_qubit_gate_time": config.single_qubit_gate_time,
        "single_qubit_gate_fidelity": config.single_qubit_gate_fidelity,
    }


def _topology(machine):
    segments = []
    for u, v, data in machine.graph.edges(data=True):
        segment = data["seg"]
        segments.append({"id": segment.id, "from": _object_location(u), "to": _object_location(v), "length": segment.length})
    return {
        "traps": [{"id": trap.id, "capacity": trap.capacity} for trap in machine.traps],
        "segments": sorted(segments, key=lambda item: item["id"]),
        "junctions": [{"id": junction.id} for junction in machine.junctions],
    }


def _object_location(obj):
    if isinstance(obj, Trap):
        return location_key("trap", obj.id)
    if isinstance(obj, Junction):
        return location_key("junction", obj.id)
    raise TypeError("Unsupported topology object: " + repr(obj))


def _particles(initial_layout):
    particles = []
    for trap_id, ions in sorted(initial_layout.items()):
        for ion in ions:
            particles.append({"id": ion, "initial_location": location_key("trap", trap_id)})
    return sorted(particles, key=lambda item: item["id"])


def _event_to_trace(event):
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
            "gate_name": info.get("gate_name"),
            "arity": info.get("arity"),
            "swap_count": info.get("swap_cnt", 0),
            "swap_hops": info.get("swap_hops", 0),
            "ion_hops": info.get("ion_hops", 0),
        },
    }


def _metrics(schedule):
    events = list(schedule.events)
    by_type = {"gate": 0, "split": 0, "move": 0, "merge": 0}
    time_by_type = {"gate": 0, "split": 0, "move": 0, "merge": 0}
    one_q = 0
    two_q = 0
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
        elif event_type == Schedule.Move:
            by_type["move"] += 1
            time_by_type["move"] += duration
        elif event_type == Schedule.Merge:
            by_type["merge"] += 1
            time_by_type["merge"] += duration
    return {
        "event_count": len(events),
        "finish_time": max((event[3] for event in events), default=0),
        "counts": by_type,
        "times": time_by_type,
        "one_qubit_gates": one_q,
        "two_qubit_gates": two_q,
        "shuttling_time": time_by_type["split"] + time_by_type["move"] + time_by_type["merge"],
    }
