import copy
import hashlib
import json
import subprocess
import sys

from comparison_metrics import (
    _architecture_hash,
    _circuit_hash,
    _model_hash,
    compare_traces,
)
from trace_audit import build_trace_validation, recompute_trace_metrics


BUNDLE_SCHEMA_VERSION = "qccd_experiment_bundle_v1"


def create_experiment_bundle(traces, metadata=None):
    """Create a local JSON-only reproducibility bundle for validated QCCD traces."""
    metadata = copy.deepcopy(metadata or {})
    normalized_traces = _validate_traces(traces)
    audits = [_audit_trace(trace) for trace in normalized_traces]
    manifest = _manifest(normalized_traces, metadata)
    bundle = {
        "bundle": {
            "schema_version": BUNDLE_SCHEMA_VERSION,
            "trace_count": len(normalized_traces),
            "trace_hashes": manifest["trace_hashes"],
            "git_commit": str(metadata.get("git_commit") or _git_commit() or "unknown"),
            "dependency_snapshot": copy.deepcopy(metadata.get("dependency_snapshot") or _dependency_snapshot()),
        },
        "manifest": manifest,
        "runs": [_run_record(trace, audit) for trace, audit in zip(normalized_traces, audits)],
        "audit": {"traces": audits},
        "comparison": copy.deepcopy(metadata.get("comparison")) or _comparison(normalized_traces),
        "command": copy.deepcopy(metadata.get("command") or metadata.get("config") or {}),
        "provenance": {
            "exporter": "experiment_bundle.create_experiment_bundle",
            "exporter_version": "1.0",
            "source": metadata.get("source") or "QCCD Schedule Visualizer",
            "reason": metadata.get("export_reason") or metadata.get("reason") or "experiment_export",
        },
        "traces": normalized_traces,
    }
    if metadata.get("screenshot_artifacts"):
        bundle["screenshot_artifacts"] = copy.deepcopy(metadata["screenshot_artifacts"])
    if metadata.get("generated_at"):
        bundle["bundle"]["generated_at"] = str(metadata["generated_at"])
    bundle["bundle"]["bundle_hash"] = _stable_hash(_bundle_hash_payload(bundle))
    return bundle


def _validate_traces(traces):
    if not isinstance(traces, list) or not traces:
        raise ValueError("experiment bundle requires at least one trace")
    result = []
    for index, trace in enumerate(traces):
        if not isinstance(trace, dict):
            raise ValueError(f"trace {index} must be an object")
        trace_hash = trace.get("trace_hash")
        if not isinstance(trace_hash, str) or not trace_hash:
            raise ValueError(f"trace {index} is missing trace_hash")
        result.append(copy.deepcopy(trace))
    return result


def _manifest(traces, metadata):
    circuit_hashes = [_circuit_hash(trace) for trace in traces]
    architecture_hashes = [_architecture_hash(trace) for trace in traces]
    timing_hashes = [_model_hash(trace, "timing_model") for trace in traces]
    metric_hashes = [_model_hash(trace, "metric_model") for trace in traces]
    qasm_hashes = _qasm_hashes(traces, metadata)
    return {
        "trace_hashes": [trace["trace_hash"] for trace in traces],
        "normalized_circuit_hash": _common_value(circuit_hashes),
        "normalized_circuit_hashes": circuit_hashes,
        "normalized_dag_hash": _common_value(circuit_hashes),
        "normalized_dag_hashes": circuit_hashes,
        "qasm_hash": _common_value(qasm_hashes),
        "qasm_hashes": qasm_hashes,
        "architecture_hash": _common_value(architecture_hashes),
        "architecture_hashes": architecture_hashes,
        "timing_model_hash": _common_value(timing_hashes),
        "timing_model_hashes": timing_hashes,
        "metric_model_hash": _common_value(metric_hashes),
        "metric_model_hashes": metric_hashes,
        "validation_status": [_validation_status(trace) for trace in traces],
    }


def _qasm_hashes(traces, metadata):
    explicit = metadata.get("qasm_hash")
    if explicit:
        return [str(explicit)] * len(traces)
    summary = metadata.get("circuit_summary") if isinstance(metadata.get("circuit_summary"), dict) else {}
    summary_hash = summary.get("normalized_qasm_hash") or summary.get("qasm_hash")
    if summary_hash:
        return [str(summary_hash)] * len(traces)
    values = []
    for trace in traces:
        circuit = trace.get("circuit") if isinstance(trace.get("circuit"), dict) else {}
        value = circuit.get("normalized_qasm_hash") or circuit.get("qasm_hash")
        values.append(str(value) if value else None)
    return values


def _run_record(trace, audit):
    run = trace.get("run") or {}
    return {
        "trace_hash": trace.get("trace_hash"),
        "run_id": run.get("id"),
        "program": run.get("program"),
        "machine": run.get("machine"),
        "mapper": run.get("mapper"),
        "reorder": run.get("reorder"),
        "scheduler_policy": run.get("scheduler_policy"),
        "seed": run.get("seed"),
        "tie_break_policy": run.get("tie_break_policy"),
        "initial_ions_per_region": run.get("initial_ions_per_region") or run.get("ions_per_region"),
        "physical_ions_per_region": run.get("physical_ions_per_region"),
        "communication_buffer_per_trap": run.get("communication_buffer_per_trap"),
        "validation": audit["validation"],
    }


def _audit_trace(trace):
    validation = build_trace_validation(trace)
    return {
        "trace_hash": trace.get("trace_hash"),
        "validation": validation,
        "metrics": recompute_trace_metrics(trace),
    }


def _comparison(traces):
    if len(traces) != 2:
        return None
    return compare_traces(traces[0], traces[1])


def _validation_status(trace):
    validation = trace.get("validation")
    if isinstance(validation, dict):
        return {"valid": validation.get("valid") is True, "errors": list(validation.get("errors") or [])}
    return {"valid": False, "errors": ["validation missing"]}


def _common_value(values):
    concrete = [value for value in values if value is not None]
    if not concrete:
        return None
    return concrete[0] if all(value == concrete[0] for value in concrete) and len(concrete) == len(values) else None


def _dependency_snapshot():
    return {"python": sys.version.split()[0]}


def _git_commit():
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short=12", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        )
    except Exception:
        return None
    return result.stdout.strip() or None


def _bundle_hash_payload(bundle):
    payload = copy.deepcopy(bundle)
    payload.get("bundle", {}).pop("bundle_hash", None)
    return payload


def _stable_hash(payload):
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()
