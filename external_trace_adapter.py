import copy

from trace_audit import build_trace_validation, recompute_trace_metrics
from trace_contract import stamp_trace_contract


EXTERNAL_SCHEMA_VERSION = "ion_trap_trace_v1"
IMPORTER_VERSION = "1.0"
FORBIDDEN_INPUT_KEYS = {"url", "uri", "path", "file", "filename", "remote_url", "local_path"}


class ExternalTraceError(ValueError):
    def __init__(self, message, details=None):
        super().__init__(message)
        self.details = list(details or [])


def adapt_external_trace(payload):
    if not isinstance(payload, dict):
        raise ExternalTraceError("External trace payload must be a JSON object")
    forbidden = sorted(key for key in FORBIDDEN_INPUT_KEYS if key in payload)
    if forbidden:
        raise ExternalTraceError(
            "External trace remote URLs and file paths are not accepted",
            [f"forbidden key: {key}" for key in forbidden],
        )
    if payload.get("schema_version") != EXTERNAL_SCHEMA_VERSION:
        raise ExternalTraceError(f"Unsupported external trace schema: {payload.get('schema_version')}")

    trace = payload.get("trace")
    if not isinstance(trace, dict):
        raise ExternalTraceError("External trace must include an object field named trace")

    normalized = copy.deepcopy(trace)
    normalized["schema_version"] = "1.0"
    normalized["device_type"] = "ion_trap"
    normalized["source_claims"] = copy.deepcopy(payload.get("source_claims") or {})
    _normalize_run(normalized, payload)
    _normalize_provenance(normalized, payload)
    normalized["metrics"] = recompute_trace_metrics(normalized)

    stamp_trace_contract(normalized)
    validation = build_trace_validation(normalized)
    normalized["validation"] = validation
    if not validation["valid"]:
        raise ExternalTraceError("Imported trace failed validation", validation["errors"])
    return normalized


def _normalize_run(trace, payload):
    source = payload.get("source") if isinstance(payload.get("source"), dict) else {}
    run = trace.setdefault("run", {})
    run.setdefault("program", "external")
    run.setdefault("machine", "external_qccd")
    run.setdefault("mapper", "unknown_external")
    run.setdefault("reorder", "unknown_external")
    run.setdefault("scheduler_policy", "unknown_external")
    run["source_label"] = source.get("label") or "External trace"


def _normalize_provenance(trace, payload):
    source = payload.get("source") if isinstance(payload.get("source"), dict) else {}
    source_provenance = source.get("provenance") if isinstance(source.get("provenance"), dict) else {}
    provenance = copy.deepcopy(source_provenance)
    provenance.setdefault("source", source.get("label") or "ExternalTrace")
    provenance["importer"] = "external_trace_adapter"
    provenance["importer_version"] = IMPORTER_VERSION
    provenance["contract_version"] = "1.0"
    trace["provenance"] = provenance
