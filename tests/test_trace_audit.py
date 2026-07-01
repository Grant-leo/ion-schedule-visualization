import copy
import json
from pathlib import Path

from trace_audit import (
    build_trace_validation,
    extract_trace_bottlenecks,
    recompute_trace_metrics,
    validate_trace_dag,
    validate_trace_metrics,
    validate_trace_physics,
)
from trace_contract import stamp_trace_contract


FIXTURE_DIR = Path(__file__).parent / "fixtures" / "trace_contract"


def load_fixture(name):
    return json.loads((FIXTURE_DIR / name).read_text(encoding="utf-8"))


def stamped(name):
    return stamp_trace_contract(load_fixture(name))


def test_build_trace_validation_accepts_a_contract_complete_trace():
    validation = build_trace_validation(stamped("valid_minimal_trace.json"))

    assert validation["valid"] is True
    assert validation["errors"] == []
    assert validation["contract"]["valid"] is True
    assert validation["physics"]["valid"] is True
    assert validation["dag"]["valid"] is True
    assert validation["metrics"]["valid"] is True
    assert validation["final_locations"] == {"0": "trap:0", "1": "trap:0"}


def test_validate_trace_physics_reports_capacity_overflow():
    validation = validate_trace_physics(stamped("invalid_capacity_overflow.json"))

    assert validation["valid"] is False
    assert any("initial occupancy 2 exceeds capacity 1" in error for error in validation["errors"])


def test_validate_trace_dag_reports_dependency_order_violation():
    validation = validate_trace_dag(stamped("invalid_dag_order.json"))

    assert validation["valid"] is False
    assert any("dag edge 0->1 violates event order" in error for error in validation["errors"])


def test_build_trace_validation_combines_contract_physics_dag_and_metric_errors():
    trace = stamped("invalid_dag_order.json")
    trace["metrics"]["event_count"] = 99
    validation = build_trace_validation(trace)

    assert validation["valid"] is False
    assert any("dag edge 0->1 violates event order" in error for error in validation["errors"])
    assert any("metrics.event_count expected 2 but found 99" in error for error in validation["errors"])


def test_recompute_trace_metrics_matches_minimal_trace_metrics():
    trace = stamped("valid_minimal_trace.json")

    assert recompute_trace_metrics(trace) == trace["metrics"]


def test_extract_trace_bottlenecks_reports_hot_segments_junctions_and_dag_stalls():
    trace = {
        "topology": {
            "traps": [{"id": 0}, {"id": 1}],
            "segments": [
                {"id": 0, "from": "trap:0", "to": "junction:0"},
                {"id": 1, "from": "junction:0", "to": "trap:1"},
            ],
            "junctions": [{"id": 0}],
        },
        "dag": {
            "nodes": [
                {"id": 0, "gate_name": "h", "qubits": [0], "arity": 1},
                {"id": 1, "gate_name": "cx", "qubits": [0, 1], "arity": 2},
            ],
            "edges": [{"source": 0, "target": 1}],
        },
        "events": [
            {"id": 0, "type": "gate", "start": 0, "end": 10, "target": "trap:0", "metadata": {"gate_id": 0}},
            {"id": 1, "type": "split", "start": 10, "end": 20, "source": "trap:0", "target": "segment:0"},
            {"id": 2, "type": "move", "start": 20, "end": 40, "source": "segment:0", "target": "segment:1"},
            {"id": 3, "type": "move", "start": 40, "end": 60, "source": "segment:0", "target": "segment:1"},
            {"id": 4, "type": "merge", "start": 60, "end": 70, "source": "segment:1", "target": "trap:1"},
            {"id": 5, "type": "gate", "start": 100, "end": 110, "target": "trap:1", "metadata": {"gate_id": 1}},
        ],
    }

    bottlenecks = extract_trace_bottlenecks(trace)

    assert bottlenecks["segments"][0]["resource"] == "segment:0"
    assert bottlenecks["segments"][0]["duration"] == 50
    assert bottlenecks["junctions"][0]["resource"] == "junction:0"
    assert bottlenecks["junctions"][0]["duration"] == 40
    assert bottlenecks["dag_stalls"][0] == {"source": 0, "target": 1, "stall_time": 90}
    assert recompute_trace_metrics(trace)["bottlenecks"] == bottlenecks


def test_recompute_trace_metrics_ignores_malformed_gate_ids_in_stall_attribution():
    trace = {
        "dag": {
            "nodes": [{"id": 0, "gate_name": "h", "qubits": [0], "arity": 1}],
            "edges": [{"source": 0, "target": 1}],
        },
        "events": [
            {"id": 0, "type": "gate", "start": 0, "end": 10, "target": "trap:0", "metadata": {"gate_id": "bad"}},
            {"id": 1, "type": "gate", "start": 20, "end": 30, "target": "trap:0", "metadata": {"gate_id": 1}},
        ],
    }

    assert recompute_trace_metrics(trace)["bottlenecks"]["dag_stalls"] == []


def test_validate_trace_metrics_reports_stale_exported_metrics():
    trace = stamped("valid_minimal_trace.json")
    trace["metrics"] = copy.deepcopy(trace["metrics"])
    trace["metrics"]["finish_time"] = 100

    validation = validate_trace_metrics(trace)

    assert validation["valid"] is False
    assert "metrics.finish_time expected 10 but found 100" in validation["errors"]
