import copy

import pytest

from experiment_bundle import create_experiment_bundle
from trace_contract import stamp_trace_contract


def minimal_trace(name="baseline", finish_time=20, scheduler="EJF"):
    trace = {
        "schema_version": "1.0",
        "device_type": "ion_trap",
        "run": {
            "id": name,
            "program": "qft_n4",
            "machine": "G3x3",
            "mapper": "Greedy",
            "reorder": "Naive",
            "scheduler_policy": scheduler,
            "seed": 12345,
            "tie_break_policy": "deterministic-id",
            "initial_ions_per_region": 2,
            "physical_ions_per_region": 3,
            "communication_buffer_per_trap": 1,
        },
        "topology": {
            "traps": [{"id": 0, "capacity": 3, "orientation": {}, "slots": [0, 1, 2]}],
            "segments": [],
            "junctions": [],
            "layout": {"trap:0": {"x": 0, "y": 0}},
        },
        "timing": {"unit": "us", "cycle_time_us": 1},
        "dag": {
            "nodes": [{"id": 0, "gate_name": "h", "qubits": [0], "arity": 1}],
            "edges": [],
        },
        "particles": [{"id": 0, "initial_location": "trap:0", "initial_slot": 0}],
        "events": [
            {
                "id": 0,
                "type": "gate",
                "start": 0,
                "end": finish_time,
                "ions": [0],
                "source": "trap:0",
                "target": "trap:0",
                "metadata": {"gate_id": 0, "gate_name": "h", "arity": 1},
            }
        ],
        "metrics": {
            "event_count": 1,
            "finish_time": finish_time,
            "counts": {"gate": 1, "split": 0, "move": 0, "merge": 0},
            "times": {"gate": finish_time, "split": 0, "move": 0, "merge": 0},
            "one_qubit_gates": 1,
            "two_qubit_gates": 0,
            "shuttling_time": 0,
            "swap_count": 0,
            "swap_hops": 0,
            "ion_hops": 0,
            "max_parallel_gates": 1,
            "cross_trap_parallel_gates": 0,
            "same_trap_gate_overlaps": 0,
            "bottlenecks": {"segments": [], "junctions": [], "largest_shuttles": [], "dag_stalls": []},
        },
    }
    stamped = stamp_trace_contract(trace)
    stamped["validation"] = {"valid": True, "errors": []}
    return stamped


def test_create_experiment_bundle_records_reproducibility_manifest_and_audit():
    trace = minimal_trace()
    bundle = create_experiment_bundle(
        [trace],
        {
            "qasm_hash": "qasm-v1",
            "command": {"program": "qft_n4", "machine": "G3x3"},
            "git_commit": "abc1234",
            "dependency_snapshot": {"python": "3.11", "qiskit": "0.45"},
            "export_reason": "unit-test",
        },
    )

    assert bundle["bundle"]["schema_version"] == "qccd_experiment_bundle_v1"
    assert bundle["bundle"]["trace_hashes"] == [trace["trace_hash"]]
    assert bundle["bundle"]["git_commit"] == "abc1234"
    assert bundle["bundle"]["dependency_snapshot"] == {"python": "3.11", "qiskit": "0.45"}
    assert bundle["manifest"]["normalized_circuit_hash"]
    assert bundle["manifest"]["normalized_dag_hash"] == bundle["manifest"]["normalized_circuit_hash"]
    assert bundle["manifest"]["qasm_hash"] == "qasm-v1"
    assert bundle["manifest"]["architecture_hash"]
    assert bundle["manifest"]["timing_model_hash"] == trace["timing_model"]["hash"]
    assert bundle["manifest"]["metric_model_hash"] == trace["metric_model"]["hash"]
    assert bundle["runs"][0]["mapper"] == "Greedy"
    assert bundle["runs"][0]["scheduler_policy"] == "EJF"
    assert bundle["runs"][0]["seed"] == 12345
    assert bundle["runs"][0]["tie_break_policy"] == "deterministic-id"
    assert bundle["runs"][0]["validation"]["valid"] is True
    assert bundle["audit"]["traces"][0]["validation"]["valid"] is True
    assert bundle["audit"]["traces"][0]["metrics"]["event_count"] == 1
    assert bundle["traces"][0]["trace_hash"] == trace["trace_hash"]
    assert bundle["command"] == {"program": "qft_n4", "machine": "G3x3"}


def test_create_experiment_bundle_computes_comparison_when_two_traces_are_exported():
    baseline = minimal_trace("baseline", finish_time=20, scheduler="EJF")
    candidate = minimal_trace("candidate", finish_time=30, scheduler="EJF-GlobalSerial")
    candidate["run"]["program"] = baseline["run"]["program"]
    candidate = stamp_trace_contract(candidate)
    candidate["validation"] = {"valid": True, "errors": []}

    bundle = create_experiment_bundle([baseline, candidate], {"qasm_hash": "qasm-v1"})

    assert bundle["comparison"]["status"] == "comparable"
    assert bundle["comparison"]["rows"]
    assert bundle["manifest"]["trace_hashes"] == [baseline["trace_hash"], candidate["trace_hash"]]


def test_create_experiment_bundle_rejects_missing_or_invalid_traces():
    with pytest.raises(ValueError, match="at least one trace"):
        create_experiment_bundle([], {})

    invalid = copy.deepcopy(minimal_trace())
    invalid.pop("trace_hash")

    with pytest.raises(ValueError, match="trace 0"):
        create_experiment_bundle([invalid], {})
