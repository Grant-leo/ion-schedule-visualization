"""Build QCCDSim Machine objects from validated custom architecture specs."""

from __future__ import annotations

from architecture_schema import validate_architecture_spec
from machine import Machine, MachineParams


def build_custom_machine(spec, capacity=None, params=None):
    normalized = validate_architecture_spec(spec)
    machine = Machine(params or MachineParams())

    traps = {}
    for trap in normalized["topology"]["traps"]:
        trap_capacity = int(capacity) if capacity is not None else int(trap["capacity"])
        traps[trap["id"]] = machine.add_trap(trap["id"], trap_capacity)

    junctions = {}
    for junction in normalized["topology"]["junctions"]:
        junctions[junction["id"]] = machine.add_junction(junction["id"])

    orientation_by_segment = {}
    for trap in normalized["topology"]["traps"]:
        for segment_id, side in trap.get("orientation", {}).items():
            orientation_by_segment[(trap["id"], int(segment_id))] = side

    for segment in normalized["topology"]["segments"]:
        source = _object_for_location(segment["from"], traps, junctions)
        target = _object_for_location(segment["to"], traps, junctions)
        trap_id = _trap_id_for_segment(segment)
        if trap_id is not None:
            trap_obj = traps[trap_id]
            other_obj = target if source is trap_obj else source
            orientation = orientation_by_segment[(trap_id, segment["id"])]
            machine.add_segment(segment["id"], trap_obj, other_obj, orientation)
        else:
            machine.add_segment(segment["id"], source, target)
        machine.segments[-1].capacity = int(segment["capacity"])
        machine.segments[-1].length = int(segment["length"])

    machine.custom_architecture = normalized
    return machine


def _object_for_location(location, traps, junctions):
    kind, raw_id = location.split(":", 1)
    obj_id = int(raw_id)
    if kind == "trap":
        return traps[obj_id]
    if kind == "junction":
        return junctions[obj_id]
    raise ValueError("Unsupported custom architecture location: " + location)


def _trap_id_for_segment(segment):
    for endpoint in (segment["from"], segment["to"]):
        if endpoint.startswith("trap:"):
            return int(endpoint.split(":", 1)[1])
    return None
