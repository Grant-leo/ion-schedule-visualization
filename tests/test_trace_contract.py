import copy
import json
from pathlib import Path

import pytest

from trace_contract import compute_trace_hash, stamp_trace_contract, validate_trace_contract


FIXTURE_DIR = Path(__file__).parent / "fixtures" / "trace_contract"


def load_fixture(name):
    return json.loads((FIXTURE_DIR / name).read_text(encoding="utf-8"))


def test_stamp_trace_contract_adds_run_identity_models_provenance_and_hash():
    trace = stamp_trace_contract(load_fixture("valid_minimal_trace.json"))

    assert trace["run"]["id"].startswith("run-")
    assert trace["provenance"]["source"] == "QCCDSim"
    assert trace["timing_model"]["name"] == "qccdsim-cycle-timing"
    assert trace["metric_model"]["name"] == "qccdsim-schedule-metrics"
    assert trace["trace_hash"] == compute_trace_hash(trace)
    assert validate_trace_contract(trace)["valid"] is True


def test_trace_hash_is_stable_across_validation_and_frontend_state():
    trace = stamp_trace_contract(load_fixture("valid_minimal_trace.json"))
    mutated = copy.deepcopy(trace)
    mutated["validation"] = {"valid": False, "checked_at": "2026-07-01T00:00:00Z"}
    mutated["frontend_state"] = {"expanded": True}

    assert compute_trace_hash(mutated) == trace["trace_hash"]


def test_trace_hash_changes_when_schedule_semantics_change():
    trace = stamp_trace_contract(load_fixture("valid_minimal_trace.json"))
    changed = copy.deepcopy(trace)
    changed["events"][0]["end"] = 11

    assert compute_trace_hash(changed) != trace["trace_hash"]


def test_validate_trace_contract_reports_missing_research_metadata():
    trace = load_fixture("valid_minimal_trace.json")
    validation = validate_trace_contract(trace)

    assert validation["valid"] is False
    assert "missing run.id" in validation["errors"]
    assert "missing provenance" in validation["errors"]
    assert "missing timing_model" in validation["errors"]
    assert "missing metric_model" in validation["errors"]
    assert "missing trace_hash" in validation["errors"]


def test_validate_trace_contract_rejects_hash_mismatch():
    trace = stamp_trace_contract(load_fixture("valid_minimal_trace.json"))
    trace["trace_hash"] = "bad"

    validation = validate_trace_contract(trace)

    assert validation["valid"] is False
    assert any("trace_hash mismatch" in error for error in validation["errors"])


@pytest.mark.parametrize("key", ["run", "topology", "timing", "dag", "particles", "events", "metrics"])
def test_validate_trace_contract_rejects_missing_core_sections(key):
    trace = stamp_trace_contract(load_fixture("valid_minimal_trace.json"))
    trace.pop(key)

    validation = validate_trace_contract(trace)

    assert validation["valid"] is False
    assert any(key in error for error in validation["errors"])
