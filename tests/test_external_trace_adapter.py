import json
from pathlib import Path

import pytest

from external_trace_adapter import ExternalTraceError, adapt_external_trace


FIXTURE_DIR = Path(__file__).parent / "fixtures" / "trace_contract"


def load_fixture(name):
    return json.loads((FIXTURE_DIR / name).read_text(encoding="utf-8"))


def test_adapt_external_trace_normalizes_identity_and_preserves_source_claims():
    trace = adapt_external_trace(load_fixture("external_valid_trace.json"))

    assert trace["validation"]["valid"] is True
    assert trace["run"]["mapper"] == "unknown_external"
    assert trace["run"]["scheduler_policy"] == "unknown_external"
    assert trace["run"]["source_label"] == "fixture external scheduler"
    assert trace["source_claims"]["scheduler"] == "external-list-scheduler"
    assert trace["provenance"]["source"] == "ExternalFixture"
    assert trace["provenance"]["importer"] == "external_trace_adapter"
    assert trace["trace_hash"]


def test_adapt_external_trace_blocks_nonadjacent_motion():
    with pytest.raises(ExternalTraceError) as excinfo:
        adapt_external_trace(load_fixture("external_invalid_nonadjacent_move.json"))

    assert any("not adjacent to segment:1" in detail for detail in excinfo.value.details)


def test_adapt_external_trace_blocks_capacity_overflow():
    with pytest.raises(ExternalTraceError) as excinfo:
        adapt_external_trace(load_fixture("external_invalid_capacity.json"))

    assert any("initial occupancy 2 exceeds capacity 1" in detail for detail in excinfo.value.details)


def test_adapt_external_trace_rejects_unsupported_schema_and_remote_or_path_inputs():
    payload = load_fixture("external_valid_trace.json")
    payload["schema_version"] = "other"
    with pytest.raises(ExternalTraceError, match="Unsupported external trace schema"):
        adapt_external_trace(payload)

    payload = load_fixture("external_valid_trace.json")
    payload["url"] = "https://example.com/trace.json"
    with pytest.raises(ExternalTraceError, match="remote URLs and file paths are not accepted"):
        adapt_external_trace(payload)

    payload = load_fixture("external_valid_trace.json")
    payload["path"] = "C:/tmp/trace.json"
    with pytest.raises(ExternalTraceError, match="remote URLs and file paths are not accepted"):
        adapt_external_trace(payload)
