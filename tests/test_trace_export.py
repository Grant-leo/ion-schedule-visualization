import json
import subprocess
import sys
from pathlib import Path

from schedule import Schedule
from simulation import SimulationConfig, run_simulation, supported_machine_names
from trace_export import export_trace, validate_trace


ROOT = Path(__file__).resolve().parents[1]


def test_run_simulation_returns_schedule_without_cli_side_effects():
    result = run_simulation(
        SimulationConfig(
            program=str(ROOT / "programs" / "benchmarks" / "qasmbench" / "small" / "grover_n2.qasm"),
            machine="L6",
            ions=1,
            mapper="Greedy",
            reorder="Naive",
            serial_trap_ops=1,
            serial_comm=0,
            serial_all=0,
            gate_type="FM",
            swap_type="GateSwap",
            single_qubit_gate_time=7,
            single_qubit_gate_fidelity=0.999,
        )
    )

    events = list(result.scheduler.schedule.events)
    assert result.parser.qbit_count == 2
    assert any(event[1] == Schedule.Gate for event in events)
    assert any(event[1] == Schedule.Split for event in events)
    assert any(event[1] == Schedule.Move for event in events)
    assert any(event[1] == Schedule.Merge for event in events)


def test_export_trace_contains_topology_events_metrics_and_validation():
    result = run_simulation(
        SimulationConfig(
            program=str(ROOT / "programs" / "benchmarks" / "qasmbench" / "small" / "grover_n2.qasm"),
            machine="L6",
            ions=1,
            mapper="Greedy",
            reorder="Naive",
            serial_trap_ops=1,
            serial_comm=0,
            serial_all=0,
            gate_type="FM",
            swap_type="GateSwap",
            single_qubit_gate_time=7,
            single_qubit_gate_fidelity=0.999,
        )
    )

    trace = export_trace(result)

    assert trace["schema_version"] == "1.0"
    assert trace["device_type"] == "ion_trap"
    assert trace["topology"]["traps"]
    assert trace["topology"]["segments"]
    assert trace["topology"]["junctions"]
    assert all("slots" in trap for trap in trace["topology"]["traps"])
    assert all("orientation" in trap for trap in trace["topology"]["traps"])
    assert "layout" in trace["topology"]
    assert trace["particles"] == [
        {"id": 0, "initial_location": "trap:0", "initial_slot": 0},
        {"id": 1, "initial_location": "trap:1", "initial_slot": 0},
    ]
    assert trace["dag"]["nodes"]
    assert trace["dag"]["edges"]
    assert {node["arity"] for node in trace["dag"]["nodes"]} >= {1, 2}
    assert {event["type"] for event in trace["events"]} >= {"gate", "split", "move", "merge"}
    gate_events = [event for event in trace["events"] if event["type"] == "gate"]
    assert all(isinstance(event["metadata"]["gate_id"], int) for event in gate_events)
    assert trace["metrics"]["event_count"] == len(trace["events"])
    assert trace["timing"]["unit"] == "us"
    assert trace["timing"]["cycle_time_us"] == 1
    assert trace["timing"]["parameters"]["split_merge_time"] == 80
    assert trace["timing"]["parameters"]["shuttle_time"] == 5
    assert trace["timing"]["parameters"]["single_qubit_gate_time"] == 7
    assert trace["run"]["ions_per_region"] == 1
    assert trace["run"]["physical_ions_per_region"] == 3
    assert trace["run"]["communication_buffer_per_trap"] == 2
    assert all(trap["initial_ion_capacity"] == 1 for trap in trace["topology"]["traps"])
    assert all(trap["physical_capacity"] == 3 for trap in trace["topology"]["traps"])
    assert all(trap["communication_buffer"] == 2 for trap in trace["topology"]["traps"])
    assert trace["validation"]["valid"] is True
    assert trace["validation"]["errors"] == []


def test_supported_machine_names_exposes_qccdsim_architectures():
    names = supported_machine_names()

    assert {"L6", "H6", "G2x3", "T4x2", "T6x3", "T8x4", "G3x3", "G9"} <= set(names)


def test_grid_qccdsim_architecture_can_run_and_exports_rich_topology():
    result = run_simulation(
        SimulationConfig(
            program=str(ROOT / "programs" / "benchmarks" / "qasmbench" / "small" / "qft_n4.qasm"),
            machine="G3x3",
            ions=2,
            mapper="Greedy",
            reorder="Naive",
            serial_trap_ops=1,
            serial_comm=0,
            serial_all=0,
            gate_type="FM",
            swap_type="GateSwap",
            single_qubit_gate_time=7,
            single_qubit_gate_fidelity=0.999,
        )
    )

    trace = export_trace(result)

    assert len(trace["topology"]["traps"]) == 9
    assert len(trace["topology"]["segments"]) == 16
    assert len(trace["topology"]["junctions"]) == 6
    assert sorted(junction["degree"] for junction in trace["topology"]["junctions"]) == [3, 3, 3, 3, 4, 4]
    assert {junction["junction_type"] for junction in trace["topology"]["junctions"]} == {"J3", "J4"}
    assert {junction["cross_time"] for junction in trace["topology"]["junctions"]} == {100, 120}
    assert trace["topology"]["layout"]["trap:0"] != trace["topology"]["layout"]["trap:8"]
    assert trace["run"]["machine"] == "G3x3"
    assert trace["validation"]["valid"] is True


def test_g9_trace_layout_keeps_traps_outside_junction_grid():
    result = run_simulation(
        SimulationConfig(
            program=str(ROOT / "programs" / "benchmarks" / "qasmbench" / "small" / "qft_n4.qasm"),
            machine="G9",
            ions=2,
            mapper="Greedy",
            reorder="Naive",
            serial_trap_ops=1,
            serial_comm=0,
            serial_all=0,
            gate_type="FM",
            swap_type="GateSwap",
            single_qubit_gate_time=7,
            single_qubit_gate_fidelity=0.999,
        )
    )

    trace = export_trace(result)
    layout = trace["topology"]["layout"]
    for segment in trace["topology"]["segments"]:
        endpoints = {segment["from"], segment["to"]}
        trap = next((item for item in endpoints if item.startswith("trap:")), None)
        junction = next((item for item in endpoints if item.startswith("junction:")), None)
        if trap and junction:
            assert layout[trap] != layout[junction]
            distance = abs(layout[trap]["x"] - layout[junction]["x"]) + abs(layout[trap]["y"] - layout[junction]["y"])
            assert distance >= 0.7


def test_curated_g9_visualizer_trace_keeps_traps_outside_junction_grid():
    trace = json.loads((ROOT / "visualizer" / "traces" / "qft_n4_g9_greedy.json").read_text(encoding="utf-8"))
    layout = trace["topology"]["layout"]

    for segment in trace["topology"]["segments"]:
        endpoints = {segment["from"], segment["to"]}
        trap = next((item for item in endpoints if item.startswith("trap:")), None)
        junction = next((item for item in endpoints if item.startswith("junction:")), None)
        if not trap or not junction:
            continue
        assert layout[trap] != layout[junction]
        distance = abs(layout[trap]["x"] - layout[junction]["x"]) + abs(layout[trap]["y"] - layout[junction]["y"])
        assert distance >= 0.7


def test_curated_l6_visualizer_traces_keep_j2_on_trap_chain_axis():
    for trace_path in (ROOT / "visualizer" / "traces").glob("*_l6_*.json"):
        trace = json.loads(trace_path.read_text(encoding="utf-8"))
        if trace["run"]["machine"] != "L6":
            continue
        layout = trace["topology"]["layout"]
        junctions = {f"junction:{junction['id']}": junction for junction in trace["topology"]["junctions"]}
        for segment in trace["topology"]["segments"]:
            endpoints = {segment["from"], segment["to"]}
            trap = next((item for item in endpoints if item.startswith("trap:")), None)
            junction = next((item for item in endpoints if item.startswith("junction:")), None)
            if not trap or not junction:
                continue
            assert junctions[junction]["junction_type"] == "J2"
            assert layout[junction]["y"] == layout[trap]["y"], trace_path.name


def test_h6_layout_places_j2_junctions_on_the_trap_ring():
    result = run_simulation(
        SimulationConfig(
            program=str(ROOT / "programs" / "benchmarks" / "qasmbench" / "small" / "qft_n4.qasm"),
            machine="H6",
            ions=2,
            mapper="Greedy",
            reorder="Naive",
            serial_trap_ops=1,
            serial_comm=0,
            serial_all=0,
            gate_type="FM",
            swap_type="GateSwap",
            single_qubit_gate_time=7,
            single_qubit_gate_fidelity=0.999,
        )
    )

    trace = export_trace(result)
    layout = trace["topology"]["layout"]
    trap_points = [layout[f"trap:{trap['id']}"] for trap in trace["topology"]["traps"]]
    center_x = sum(point["x"] for point in trap_points) / len(trap_points)
    center_y = sum(point["y"] for point in trap_points) / len(trap_points)
    average_trap_radius = sum(
        ((point["x"] - center_x) ** 2 + (point["y"] - center_y) ** 2) ** 0.5 for point in trap_points
    ) / len(trap_points)

    assert {junction["junction_type"] for junction in trace["topology"]["junctions"]} == {"J2"}
    for junction in trace["topology"]["junctions"]:
        point = layout[f"junction:{junction['id']}"]
        radius = ((point["x"] - center_x) ** 2 + (point["y"] - center_y) ** 2) ** 0.5
        assert radius >= average_trap_radius * 0.9


def test_validate_trace_rejects_gate_when_ions_are_not_colocated():
    bad_trace = {
        "schema_version": "1.0",
        "device_type": "ion_trap",
        "topology": {"traps": [{"id": 0}, {"id": 1}], "segments": [], "junctions": []},
        "particles": [
            {"id": 0, "initial_location": "trap:0"},
            {"id": 1, "initial_location": "trap:1"},
        ],
        "events": [
            {
                "id": 0,
                "type": "gate",
                "start": 0,
                "end": 10,
                "ions": [0, 1],
                "source": "trap:0",
                "target": "trap:0",
                "metadata": {"arity": 2},
            }
        ],
        "metrics": {"event_count": 1},
    }

    validation = validate_trace(bad_trace)

    assert validation["valid"] is False
    assert any("not at trap:0" in error for error in validation["errors"])


def test_validate_trace_rejects_unsupported_event_types_and_gates_outside_traps():
    bad_trace = {
        "schema_version": "1.0",
        "device_type": "ion_trap",
        "topology": {
            "traps": [{"id": 0, "capacity": 2, "orientation": {"0": "R"}}],
            "segments": [{"id": 0, "from": "trap:0", "to": "junction:0", "length": 10}],
            "junctions": [{"id": 0}],
        },
        "dag": {"nodes": [{"id": 0, "gate_name": "h", "qubits": [0], "arity": 1}], "edges": []},
        "particles": [{"id": 0, "initial_location": "trap:0"}],
        "events": [
            {
                "id": 0,
                "type": "teleport",
                "start": 0,
                "end": 10,
                "ions": [0],
                "source": "trap:0",
                "target": "segment:0",
                "metadata": {},
            },
            {
                "id": 1,
                "type": "gate",
                "start": 10,
                "end": 20,
                "ions": [0],
                "source": "segment:0",
                "target": "segment:0",
                "metadata": {"gate_id": 0, "arity": 1},
            },
        ],
        "metrics": {"event_count": 2},
    }

    validation = validate_trace(bad_trace)

    assert validation["valid"] is False
    assert any("unsupported event type teleport" in error for error in validation["errors"])
    assert any("gate event 1 must execute inside one trap" in error for error in validation["errors"])


def test_validate_trace_rejects_dag_nodes_without_matching_gate_events():
    bad_trace = {
        "schema_version": "1.0",
        "device_type": "ion_trap",
        "topology": {"traps": [{"id": 0, "capacity": 1}], "segments": [], "junctions": []},
        "dag": {
            "nodes": [
                {"id": 0, "gate_name": "h", "qubits": [0], "arity": 1},
                {"id": 1, "gate_name": "x", "qubits": [0], "arity": 1},
            ],
            "edges": [{"source": 0, "target": 1}],
        },
        "particles": [{"id": 0, "initial_location": "trap:0"}],
        "events": [
            {
                "id": 0,
                "type": "gate",
                "start": 0,
                "end": 10,
                "ions": [0],
                "source": "trap:0",
                "target": "trap:0",
                "metadata": {"gate_id": 0, "arity": 1},
            }
        ],
        "metrics": {"event_count": 1},
    }

    validation = validate_trace(bad_trace)

    assert validation["valid"] is False
    assert any("dag node 1 has no matching gate event" in error for error in validation["errors"])


def test_validate_trace_rejects_dag_dependency_timing_violations():
    bad_trace = {
        "schema_version": "1.0",
        "device_type": "ion_trap",
        "topology": {"traps": [{"id": 0, "capacity": 1}], "segments": [], "junctions": []},
        "dag": {
            "nodes": [
                {"id": 0, "gate_name": "h", "qubits": [0], "arity": 1},
                {"id": 1, "gate_name": "x", "qubits": [0], "arity": 1},
            ],
            "edges": [{"source": 0, "target": 1}],
        },
        "particles": [{"id": 0, "initial_location": "trap:0"}],
        "events": [
            {
                "id": 0,
                "type": "gate",
                "start": 0,
                "end": 10,
                "ions": [0],
                "source": "trap:0",
                "target": "trap:0",
                "metadata": {"gate_id": 0, "arity": 1},
            },
            {
                "id": 1,
                "type": "gate",
                "start": 5,
                "end": 15,
                "ions": [0],
                "source": "trap:0",
                "target": "trap:0",
                "metadata": {"gate_id": 1, "arity": 1},
            },
        ],
        "metrics": {"event_count": 2},
    }

    validation = validate_trace(bad_trace)

    assert validation["valid"] is False
    assert any("dag edge 0->1 violates event order" in error for error in validation["errors"])


def test_validate_trace_rejects_overlapping_events_for_same_ion():
    bad_trace = {
        "schema_version": "1.0",
        "device_type": "ion_trap",
        "topology": {
            "traps": [{"id": 0}, {"id": 1}],
            "segments": [{"id": 0, "from": "trap:0", "to": "trap:1", "length": 10}],
            "junctions": [],
        },
        "particles": [{"id": 0, "initial_location": "trap:0"}],
        "events": [
            {
                "id": 0,
                "type": "split",
                "start": 0,
                "end": 10,
                "ions": [0],
                "source": "trap:0",
                "target": "segment:0",
                "metadata": {},
            },
            {
                "id": 1,
                "type": "merge",
                "start": 5,
                "end": 20,
                "ions": [0],
                "source": "segment:0",
                "target": "trap:1",
                "metadata": {},
            },
        ],
        "metrics": {"event_count": 2},
    }

    validation = validate_trace(bad_trace)

    assert validation["valid"] is False
    assert any("busy until 10" in error for error in validation["errors"])


def test_validate_trace_rejects_overlapping_trap_operations_on_different_ions():
    bad_trace = {
        "schema_version": "1.0",
        "device_type": "ion_trap",
        "topology": {"traps": [{"id": 0, "capacity": 3}], "segments": [], "junctions": []},
        "particles": [
            {"id": 0, "initial_location": "trap:0"},
            {"id": 1, "initial_location": "trap:0"},
        ],
        "events": [
            {
                "id": 0,
                "type": "gate",
                "start": 0,
                "end": 10,
                "ions": [0],
                "source": "trap:0",
                "target": "trap:0",
                "metadata": {"arity": 1},
            },
            {
                "id": 1,
                "type": "gate",
                "start": 5,
                "end": 15,
                "ions": [1],
                "source": "trap:0",
                "target": "trap:0",
                "metadata": {"arity": 1},
            },
        ],
        "metrics": {"event_count": 2},
    }

    validation = validate_trace(bad_trace)

    assert validation["valid"] is False
    assert any("trap:0 busy until 10" in error for error in validation["errors"])


def test_validate_trace_rejects_duplicate_topology_ids_and_missing_locations():
    bad_trace = {
        "schema_version": "1.0",
        "device_type": "ion_trap",
        "topology": {
            "traps": [{"id": 0, "capacity": 2}, {"id": 0, "capacity": 2}],
            "segments": [{"id": 0, "from": "trap:0", "to": "junction:0", "length": 10}],
            "junctions": [{"id": 0}, {"id": 0}],
        },
        "particles": [{"id": 0, "initial_location": "trap:0"}],
        "events": [
            {
                "id": 0,
                "type": "split",
                "start": 0,
                "end": 10,
                "ions": [0],
                "source": "trap:0",
                "target": "segment:missing",
                "metadata": {},
            }
        ],
        "metrics": {"event_count": 1},
    }

    validation = validate_trace(bad_trace)

    assert validation["valid"] is False
    assert any("duplicate trap id 0" in error for error in validation["errors"])
    assert any("duplicate junction id 0" in error for error in validation["errors"])
    assert any("unknown target segment:missing" in error for error in validation["errors"])


def test_validate_trace_rejects_malformed_topology_collections_without_throwing():
    bad_trace = {
        "schema_version": "1.0",
        "device_type": "ion_trap",
        "topology": {"traps": {}, "segments": None, "junctions": "bad"},
        "particles": [],
        "events": [],
        "metrics": {"event_count": 0},
    }

    validation = validate_trace(bad_trace)

    assert validation["valid"] is False
    assert any("topology.traps must be a list" in error for error in validation["errors"])
    assert any("topology.segments must be a list" in error for error in validation["errors"])
    assert any("topology.junctions must be a list" in error for error in validation["errors"])


def test_validate_trace_rejects_missing_required_top_level_fields_without_throwing():
    validation = validate_trace({})

    assert validation["valid"] is False
    assert any("unsupported schema_version" in error for error in validation["errors"])
    assert any("unsupported device_type" in error for error in validation["errors"])
    assert any("topology must be an object" in error for error in validation["errors"])
    assert any("particles must be a list" in error for error in validation["errors"])
    assert any("events must be a list" in error for error in validation["errors"])


def test_validate_trace_rejects_malformed_trap_orientation_without_throwing():
    bad_trace = {
        "schema_version": "1.0",
        "device_type": "ion_trap",
        "topology": {
            "traps": [{"id": 0, "capacity": 1, "orientation": {"bad": "L"}}],
            "segments": [],
            "junctions": [],
        },
        "particles": [],
        "events": [],
        "metrics": {"event_count": 0},
    }

    validation = validate_trace(bad_trace)

    assert validation["valid"] is False
    assert any("trap 0 orientation segment id bad is invalid" in error for error in validation["errors"])


def test_validate_trace_rejects_non_object_trap_orientation_without_throwing():
    bad_trace = {
        "schema_version": "1.0",
        "device_type": "ion_trap",
        "topology": {
            "traps": [{"id": 0, "capacity": 1, "orientation": []}],
            "segments": [],
            "junctions": [],
        },
        "particles": [],
        "events": [],
        "metrics": {"event_count": 0},
    }

    validation = validate_trace(bad_trace)

    assert validation["valid"] is False
    assert any("trap 0 orientation must be a dict" in error for error in validation["errors"])


def test_validate_trace_rejects_malformed_particles_and_events_without_throwing():
    bad_trace = {
        "schema_version": "1.0",
        "device_type": "ion_trap",
        "topology": {"traps": [], "segments": [], "junctions": []},
        "dag": {"nodes": [{"id": 0, "gate_name": "h", "qubits": [0], "arity": 1}], "edges": []},
        "particles": None,
        "events": "bad",
        "metrics": None,
    }

    validation = validate_trace(bad_trace)

    assert validation["valid"] is False
    assert any("particles must be a list" in error for error in validation["errors"])
    assert any("events must be a list" in error for error in validation["errors"])
    assert any("metrics must be an object" in error for error in validation["errors"])


def test_validate_trace_rejects_malformed_event_fields_without_throwing():
    bad_trace = {
        "schema_version": "1.0",
        "device_type": "ion_trap",
        "topology": {"traps": [{"id": 0, "capacity": 1}], "segments": [], "junctions": []},
        "dag": {"nodes": [{"id": 0, "gate_name": "h", "qubits": [0], "arity": 1}], "edges": []},
        "particles": [{"id": 0, "initial_location": "trap:0"}],
        "events": [{"id": 0, "type": "gate", "ions": [0], "metadata": {"gate_id": 0, "arity": 1}}],
        "metrics": {"event_count": 1},
    }

    validation = validate_trace(bad_trace)

    assert validation["valid"] is False
    assert any("event 0 must include numeric start and end" in error for error in validation["errors"])
    assert any("event 0 must include source and target" in error for error in validation["errors"])


def test_validate_trace_rejects_initial_trap_capacity_overflow_and_event_count_mismatch():
    bad_trace = {
        "schema_version": "1.0",
        "device_type": "ion_trap",
        "topology": {
            "traps": [{"id": 0, "capacity": 1}],
            "segments": [],
            "junctions": [],
        },
        "particles": [
            {"id": 0, "initial_location": "trap:0"},
            {"id": 1, "initial_location": "trap:0"},
        ],
        "events": [],
        "metrics": {"event_count": 3},
    }

    validation = validate_trace(bad_trace)

    assert validation["valid"] is False
    assert any("trap:0 initial occupancy 2 exceeds capacity 1" in error for error in validation["errors"])
    assert any("metrics event_count 3 does not match 0 events" in error for error in validation["errors"])


def test_validate_trace_rejects_split_endpoint_that_disagrees_with_architecture_port():
    bad_trace = {
        "schema_version": "1.0",
        "device_type": "ion_trap",
        "topology": {
            "traps": [{"id": 0, "capacity": 1, "orientation": {"0": "R"}}],
            "segments": [{"id": 0, "from": "trap:0", "to": "junction:0", "length": 10}],
            "junctions": [{"id": 0}],
        },
        "particles": [{"id": 0, "initial_location": "trap:0"}],
        "events": [
            {
                "id": 0,
                "type": "split",
                "start": 0,
                "end": 80,
                "ions": [0],
                "source": "trap:0",
                "target": "segment:0",
                "metadata": {"endpoint": "L"},
            }
        ],
        "metrics": {"event_count": 1},
    }

    validation = validate_trace(bad_trace)

    assert validation["valid"] is False
    assert any("endpoint L does not match trap:0 segment:0 orientation R" in error for error in validation["errors"])


def test_validate_trace_rejects_non_endpoint_split_without_internal_swaps():
    bad_trace = {
        "schema_version": "1.0",
        "device_type": "ion_trap",
        "topology": {
            "traps": [{"id": 0, "capacity": 3, "orientation": {"0": "R"}}],
            "segments": [{"id": 0, "from": "trap:0", "to": "junction:0", "length": 10}],
            "junctions": [{"id": 0}],
        },
        "particles": [
            {"id": 0, "initial_location": "trap:0", "initial_slot": 0},
            {"id": 1, "initial_location": "trap:0", "initial_slot": 1},
            {"id": 2, "initial_location": "trap:0", "initial_slot": 2},
        ],
        "events": [
            {
                "id": 0,
                "type": "split",
                "start": 0,
                "end": 80,
                "ions": [0],
                "source": "trap:0",
                "target": "segment:0",
                "metadata": {"endpoint": "R"},
            }
        ],
        "metrics": {"event_count": 1},
    }

    validation = validate_trace(bad_trace)

    assert validation["valid"] is False
    assert any("split ion 0 is not at R endpoint of trap:0" in error for error in validation["errors"])


def test_validate_trace_rejects_internal_split_metadata_that_cannot_reach_endpoint():
    bad_trace = {
        "schema_version": "1.0",
        "device_type": "ion_trap",
        "topology": {
            "traps": [{"id": 0, "capacity": 3, "orientation": {"0": "R"}}],
            "segments": [{"id": 0, "from": "trap:0", "to": "junction:0", "length": 10}],
            "junctions": [{"id": 0}],
        },
        "particles": [
            {"id": 0, "initial_location": "trap:0", "initial_slot": 0},
            {"id": 1, "initial_location": "trap:0", "initial_slot": 1},
            {"id": 2, "initial_location": "trap:0", "initial_slot": 2},
        ],
        "events": [
            {
                "id": 0,
                "type": "split",
                "start": 0,
                "end": 80,
                "ions": [0],
                "source": "trap:0",
                "target": "segment:0",
                "metadata": {"endpoint": "R", "swap_count": 1, "swap_hops": 1, "swap_ions": [0, 2]},
            }
        ],
        "metrics": {"event_count": 1},
    }

    validation = validate_trace(bad_trace)

    assert validation["valid"] is False
    assert any("needs 2 swap hops" in error for error in validation["errors"])


def test_validate_trace_rejects_shuttling_that_skips_topology_adjacency():
    bad_trace = {
        "schema_version": "1.0",
        "device_type": "ion_trap",
        "topology": {
            "traps": [
                {"id": 0, "capacity": 1, "orientation": {"0": "R"}},
                {"id": 1, "capacity": 1, "orientation": {"1": "L"}},
                {"id": 2, "capacity": 1, "orientation": {"2": "L"}},
            ],
            "segments": [
                {"id": 0, "from": "trap:0", "to": "junction:0", "length": 10},
                {"id": 1, "from": "junction:0", "to": "trap:1", "length": 10},
                {"id": 2, "from": "junction:1", "to": "trap:2", "length": 10},
            ],
            "junctions": [{"id": 0}, {"id": 1}],
        },
        "particles": [{"id": 0, "initial_location": "trap:0"}],
        "events": [
            {
                "id": 0,
                "type": "split",
                "start": 0,
                "end": 10,
                "ions": [0],
                "source": "trap:0",
                "target": "segment:0",
                "metadata": {"endpoint": "R"},
            },
            {
                "id": 1,
                "type": "move",
                "start": 10,
                "end": 20,
                "ions": [0],
                "source": "segment:0",
                "target": "segment:2",
                "metadata": {},
            },
        ],
        "metrics": {"event_count": 2},
    }

    validation = validate_trace(bad_trace)

    assert validation["valid"] is False
    assert any("not adjacent to segment:2" in error for error in validation["errors"])


def test_validate_trace_rejects_overlapping_segment_use():
    bad_trace = {
        "schema_version": "1.0",
        "device_type": "ion_trap",
        "topology": {
            "traps": [
                {"id": 0, "capacity": 1, "orientation": {"0": "R"}},
                {"id": 1, "capacity": 1, "orientation": {"0": "L"}},
            ],
            "segments": [{"id": 0, "from": "trap:0", "to": "trap:1", "length": 10}],
            "junctions": [],
        },
        "particles": [
            {"id": 0, "initial_location": "trap:0"},
            {"id": 1, "initial_location": "trap:1"},
        ],
        "events": [
            {
                "id": 0,
                "type": "split",
                "start": 0,
                "end": 10,
                "ions": [0],
                "source": "trap:0",
                "target": "segment:0",
                "metadata": {"endpoint": "R"},
            },
            {
                "id": 1,
                "type": "split",
                "start": 5,
                "end": 15,
                "ions": [1],
                "source": "trap:1",
                "target": "segment:0",
                "metadata": {"endpoint": "L"},
            },
        ],
        "metrics": {"event_count": 2},
    }

    validation = validate_trace(bad_trace)

    assert validation["valid"] is False
    assert any("segment:0 busy until 10" in error for error in validation["errors"])


def test_validate_trace_rejects_overlapping_junction_crossings():
    bad_trace = {
        "schema_version": "1.0",
        "device_type": "ion_trap",
        "topology": {
            "traps": [{"id": trap_id, "capacity": 1} for trap_id in range(4)],
            "segments": [
                {"id": 0, "from": "trap:0", "to": "junction:0", "length": 10},
                {"id": 1, "from": "junction:0", "to": "trap:1", "length": 10},
                {"id": 2, "from": "trap:2", "to": "junction:0", "length": 10},
                {"id": 3, "from": "junction:0", "to": "trap:3", "length": 10},
            ],
            "junctions": [{"id": 0}],
        },
        "particles": [
            {"id": 0, "initial_location": "segment:0"},
            {"id": 1, "initial_location": "segment:2"},
        ],
        "events": [
            {
                "id": 0,
                "type": "move",
                "start": 0,
                "end": 10,
                "ions": [0],
                "source": "segment:0",
                "target": "segment:1",
                "metadata": {},
            },
            {
                "id": 1,
                "type": "move",
                "start": 5,
                "end": 15,
                "ions": [1],
                "source": "segment:2",
                "target": "segment:3",
                "metadata": {},
            },
        ],
        "metrics": {"event_count": 2},
    }

    validation = validate_trace(bad_trace)

    assert validation["valid"] is False
    assert any("junction:0 busy until 10" in error for error in validation["errors"])


def test_validate_trace_rejects_dynamic_trap_capacity_overflow_after_merge():
    bad_trace = {
        "schema_version": "1.0",
        "device_type": "ion_trap",
        "topology": {
            "traps": [
                {"id": 0, "capacity": 1, "orientation": {"0": "R"}},
                {"id": 1, "capacity": 1, "orientation": {"0": "L"}},
            ],
            "segments": [{"id": 0, "from": "trap:0", "to": "trap:1", "length": 10}],
            "junctions": [],
        },
        "particles": [
            {"id": 0, "initial_location": "trap:0"},
            {"id": 1, "initial_location": "trap:1"},
        ],
        "events": [
            {
                "id": 0,
                "type": "split",
                "start": 0,
                "end": 10,
                "ions": [0],
                "source": "trap:0",
                "target": "segment:0",
                "metadata": {"endpoint": "R"},
            },
            {
                "id": 1,
                "type": "merge",
                "start": 10,
                "end": 20,
                "ions": [0],
                "source": "segment:0",
                "target": "trap:1",
                "metadata": {"endpoint": "L"},
            },
        ],
        "metrics": {"event_count": 2},
    }

    validation = validate_trace(bad_trace)

    assert validation["valid"] is False
    assert any("trap:1 occupancy 2 exceeds capacity 1" in error for error in validation["errors"])


def test_export_trace_cli_writes_valid_json(tmp_path):
    output = tmp_path / "grover_trace.json"
    result = subprocess.run(
        [
            sys.executable,
            str(ROOT / "export_trace.py"),
            str(ROOT / "programs" / "benchmarks" / "qasmbench" / "small" / "grover_n2.qasm"),
            str(output),
            "--machine",
            "L6",
            "--ions",
            "1",
            "--mapper",
            "Greedy",
            "--single-qubit-gate-time",
            "7",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=60,
    )

    assert result.returncode == 0, result.stderr + result.stdout
    trace = json.loads(output.read_text(encoding="utf-8"))
    assert trace["validation"]["valid"] is True
    assert trace["metrics"]["counts"]["move"] == 1
