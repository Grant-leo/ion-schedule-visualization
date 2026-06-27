import json
import subprocess
import sys
from pathlib import Path

from schedule import Schedule
from simulation import SimulationConfig, run_simulation
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
    assert trace["particles"] == [
        {"id": 0, "initial_location": "trap:0"},
        {"id": 1, "initial_location": "trap:1"},
    ]
    assert {event["type"] for event in trace["events"]} >= {"gate", "split", "move", "merge"}
    assert trace["metrics"]["event_count"] == len(trace["events"])
    assert trace["validation"]["valid"] is True
    assert trace["validation"]["errors"] == []


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
