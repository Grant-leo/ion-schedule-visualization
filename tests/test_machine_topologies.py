from simulation import SimulationConfig, build_machine, supported_machine_names
from architecture_builder import build_custom_machine
from architecture_schema import validate_architecture_spec

import json
from pathlib import Path


FIXTURE_DIR = Path(__file__).parent / "fixtures" / "architectures"


def load_architecture_fixture(name):
    return json.loads((FIXTURE_DIR / name).read_text(encoding="utf-8"))


def test_supported_machines_export_unique_topology_ids():
    for machine_name in supported_machine_names():
        machine = build_machine(SimulationConfig(program="unused.qasm", machine=machine_name, ions=2))

        trap_ids = [trap.id for trap in machine.traps]
        junction_ids = [junction.id for junction in machine.junctions]
        segment_ids = [segment.id for segment in machine.segments]

        assert len(trap_ids) == len(set(trap_ids)), machine_name
        assert len(junction_ids) == len(set(junction_ids)), machine_name
        assert len(segment_ids) == len(set(segment_ids)), machine_name


def test_g3x3_grid_architecture_uses_both_trap_chain_ports():
    machine = build_machine(SimulationConfig(program="unused.qasm", machine="G3x3", ions=2))

    port_sets = [set(trap.orientation.values()) for trap in machine.traps]

    assert {"L", "R"} <= set.union(*port_sets)
    assert any({"L", "R"} <= ports for ports in port_sets)


def test_custom_architecture_builder_matches_validated_topology():
    spec = load_architecture_fixture("custom_grid_no_layout_valid.json")
    normalized = validate_architecture_spec(spec)
    machine = build_custom_machine(spec, capacity=5)

    assert len(machine.traps) == len(normalized["topology"]["traps"])
    assert len(machine.junctions) == len(normalized["topology"]["junctions"])
    assert len(machine.segments) == len(normalized["topology"]["segments"])
    assert all(trap.capacity == 5 for trap in machine.traps)
    assert machine.graph.degree(machine.junctions[0]) == 4


def test_simulation_build_machine_accepts_custom_architecture_spec():
    spec = load_architecture_fixture("custom_linear_valid.json")
    config = SimulationConfig(program="unused.qasm", machine="CUSTOM", ions=3, architecture_spec=spec)

    machine = build_machine(config)

    assert [trap.capacity for trap in machine.traps] == [3, 3, 3]
    assert machine.traps[1].orientation == {1: "L", 2: "R"}
