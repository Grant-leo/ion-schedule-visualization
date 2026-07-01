import copy
import json
from pathlib import Path

from trace_audit import (
    build_trace_validation,
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


def test_validate_trace_metrics_reports_stale_exported_metrics():
    trace = stamped("valid_minimal_trace.json")
    trace["metrics"] = copy.deepcopy(trace["metrics"])
    trace["metrics"]["finish_time"] = 100

    validation = validate_trace_metrics(trace)

    assert validation["valid"] is False
    assert "metrics.finish_time expected 10 but found 100" in validation["errors"]
