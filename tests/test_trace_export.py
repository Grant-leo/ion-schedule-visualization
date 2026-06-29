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
