import copy

from comparison_metrics import compare_traces, trace_architecture_hash, trace_circuit_hash, trace_fidelity
from trace_contract import stamp_trace_contract


def minimal_trace(name, finish_time=100, shuttle_rounds=1, fidelity=0.98, program="qft_n4.qasm", seed=123):
    events = [
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
    ]
    event_id = 1
    cursor = 10
    for round_index in range(shuttle_rounds):
        events.extend(
            [
                {
                    "id": event_id,
                    "type": "split",
                    "start": cursor,
                    "end": cursor + 10,
                    "ions": [0],
                    "source": f"trap:{round_index}",
                    "target": f"segment:{round_index}",
                    "metadata": {"swap_count": 1 if round_index == 0 else 0, "swap_hops": 2 if round_index == 0 else 0, "ion_hops": 2},
                },
                {
                    "id": event_id + 1,
                    "type": "move",
                    "start": cursor + 10,
                    "end": cursor + 20,
                    "ions": [0],
                    "source": f"segment:{round_index}",
                    "target": f"segment:{round_index + 1}",
                    "metadata": {},
                },
                {
                    "id": event_id + 2,
                    "type": "merge",
                    "start": cursor + 20,
                    "end": cursor + 30,
                    "ions": [0],
                    "source": f"segment:{round_index + 1}",
                    "target": f"trap:{round_index + 1}",
                    "metadata": {},
                },
            ]
        )
        event_id += 3
        cursor += 30
    events.append(
        {
            "id": event_id,
            "type": "gate",
            "start": finish_time - 10,
            "end": finish_time,
            "ions": [0, 1],
            "source": "trap:1",
            "target": "trap:1",
            "metadata": {"gate_id": 1, "arity": 2},
        }
    )
    trace = {
        "schema_version": "1.0",
        "device_type": "ion_trap",
        "run": {
            "id": name,
            "program": program,
            "machine": "G3x3",
            "mapper": "Greedy",
            "scheduler_policy": "EJF",
            "seed": seed,
            "tie_break_policy": "stable",
            "single_qubit_gate_fidelity": 0.999,
            "two_qubit_gate_fidelity": 0.992,
            "shuttle_fidelity": 0.9995,
        },
        "topology": {"traps": [], "segments": [], "junctions": []},
        "timing": {"unit": "us", "cycle_time_us": 1},
        "architecture_hash": "architecture-v1",
        "dag": {
            "nodes": [
                {"id": 0, "gate_name": "h", "qubits": [0], "arity": 1},
                {"id": 1, "gate_name": "cx", "qubits": [0, 1], "arity": 2},
            ],
            "edges": [{"source": 0, "target": 1}],
        },
        "particles": [],
        "events": events,
        "metrics": {
            "event_count": len(events),
            "finish_time": finish_time,
            "counts": {"gate": 2, "split": shuttle_rounds, "move": shuttle_rounds, "merge": shuttle_rounds},
            "times": {"gate": 20, "split": 10 * shuttle_rounds, "move": 10 * shuttle_rounds, "merge": 10 * shuttle_rounds},
            "one_qubit_gates": 1,
            "two_qubit_gates": 1,
            "shuttling_time": 30 * shuttle_rounds,
            "swap_count": 1,
            "swap_hops": 2,
            "ion_hops": 2 * shuttle_rounds,
            "max_parallel_gates": 1,
            "cross_trap_parallel_gates": 0,
            "same_trap_gate_overlaps": 0,
            "fidelity": fidelity,
        },
    }
    trace["validation"] = {"valid": True, "errors": []}
    return stamp_trace_contract(trace)


def row_by_metric(result, metric):
    return {row["metric"]: row for row in result["rows"]}[metric]


def test_compare_traces_reports_metric_deltas_and_best_values():
    baseline = minimal_trace("baseline", finish_time=100, shuttle_rounds=2, fidelity=0.96)
    candidate = minimal_trace("candidate", finish_time=80, shuttle_rounds=1, fidelity=0.98)

    result = compare_traces(baseline, candidate)

    assert result["status"] == "comparable"
    assert result["valid"] is True
    assert row_by_metric(result, "total_time")["delta"] == -20
    assert row_by_metric(result, "total_time")["winner"] == "candidate"
    assert row_by_metric(result, "shuttles")["delta"] == -3
    assert row_by_metric(result, "fidelity")["delta"] == 0.020000000000000018
    assert row_by_metric(result, "fidelity")["winner"] == "candidate"
    assert row_by_metric(result, "channel_pressure")["baseline"] == 80
    assert row_by_metric(result, "channel_pressure")["candidate"] == 40
    assert row_by_metric(result, "dag_stall_time")["baseline"] == 80
    assert row_by_metric(result, "dag_stall_time")["candidate"] == 60


def test_public_trace_helpers_match_comparison_identity_and_fidelity():
    trace = minimal_trace("sample", fidelity=0.975)

    assert trace_circuit_hash(trace)
    assert trace_architecture_hash(trace) == "architecture-v1"
    assert trace_fidelity(trace) == 0.975


def test_compare_traces_marks_different_circuits_non_comparable():
    baseline = minimal_trace("baseline")
    candidate = minimal_trace("candidate", program="adder_n10.qasm")
    candidate["dag"] = copy.deepcopy(candidate["dag"])
    candidate["dag"]["nodes"].append({"id": 2, "gate_name": "h", "qubits": [1], "arity": 1})
    stamp_trace_contract(candidate)

    result = compare_traces(baseline, candidate)

    assert result["status"] == "non_comparable"
    assert result["valid"] is False
    assert any("circuit" in reason for reason in result["reasons"])


def test_compare_traces_marks_timing_model_mismatch_non_comparable():
    baseline = minimal_trace("baseline")
    candidate = minimal_trace("candidate")
    candidate["timing_model"] = copy.deepcopy(candidate["timing_model"])
    candidate["timing_model"]["hash"] = "wrong"

    result = compare_traces(baseline, candidate)

    assert result["status"] == "non_comparable"
    assert any("timing model" in reason for reason in result["reasons"])


def test_compare_traces_marks_architecture_mismatch_non_comparable():
    baseline = minimal_trace("baseline")
    candidate = minimal_trace("candidate")
    candidate["architecture_hash"] = "different-architecture"

    result = compare_traces(baseline, candidate)

    assert result["status"] == "non_comparable"
    assert any("architecture" in reason for reason in result["reasons"])


def test_compare_traces_reports_seed_and_tie_break_flags_without_blocking():
    baseline = minimal_trace("baseline", seed=1)
    candidate = minimal_trace("candidate", seed=2)
    candidate["run"]["tie_break_policy"] = "random"
    stamp_trace_contract(candidate)

    result = compare_traces(baseline, candidate)

    assert result["status"] == "comparable"
    assert "seed_mismatch" in result["flags"]
    assert "tie_break_mismatch" in result["flags"]


def test_compare_traces_recomputes_stale_metric_counts_from_events():
    baseline = minimal_trace("baseline", finish_time=100, shuttle_rounds=2)
    candidate = minimal_trace("candidate", finish_time=80, shuttle_rounds=1)
    baseline["metrics"]["finish_time"] = 999
    baseline["metrics"]["counts"] = {"gate": 2, "split": 99, "move": 99, "merge": 99}

    result = compare_traces(baseline, candidate)

    assert row_by_metric(result, "total_time")["baseline"] == 100
    assert row_by_metric(result, "shuttles")["baseline"] == 6


def test_compare_traces_reports_delta_markers_only_on_comparison_result():
    baseline = minimal_trace("baseline", finish_time=100, shuttle_rounds=2)
    candidate = minimal_trace("candidate", finish_time=80, shuttle_rounds=1)

    result = compare_traces(baseline, candidate)

    marker = next(item for item in result["delta_markers"] if item["kind"] == "shuttling_improvement")
    assert marker["kind"] == "shuttling_improvement"
    assert marker["metric"] == "shuttles"
    assert marker["delta"] == -3
    assert "delta_markers" not in baseline["metrics"]
    assert "delta_markers" not in candidate["metrics"]


def test_compare_traces_refuses_explicitly_invalid_trace():
    baseline = minimal_trace("baseline")
    candidate = minimal_trace("candidate")
    candidate["validation"] = {"valid": False, "errors": ["dag node 1 has no matching gate event"]}

    result = compare_traces(baseline, candidate)

    assert result["status"] == "non_comparable"
    assert any("validation failed" in reason for reason in result["reasons"])


def test_compare_traces_requires_backend_validation_to_be_present_and_valid():
    baseline = minimal_trace("baseline")
    candidate = minimal_trace("candidate")
    del candidate["validation"]

    result = compare_traces(baseline, candidate)

    assert result["status"] == "non_comparable"
    assert any("validation missing" in reason for reason in result["reasons"])
