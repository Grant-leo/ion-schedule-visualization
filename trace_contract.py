import copy
import hashlib
import json


SCHEMA_VERSION = "1.0"
DEVICE_TYPE = "ion_trap"

TIMING_MODEL = {
    "name": "qccdsim-cycle-timing",
    "version": "1.0",
    "unit": "us",
    "fields": [
        "cycle_time_us",
        "split_merge_time",
        "shuttle_time",
        "junction_cross_time",
        "ion_swap_time",
        "single_qubit_gate_time",
    ],
}

METRIC_MODEL = {
    "name": "qccdsim-schedule-metrics",
    "version": "1.0",
    "fields": [
        "event_count",
        "finish_time",
        "counts",
        "times",
        "one_qubit_gates",
        "two_qubit_gates",
        "shuttling_time",
        "swap_count",
        "swap_hops",
        "ion_hops",
        "max_parallel_gates",
        "cross_trap_parallel_gates",
        "same_trap_gate_overlaps",
    ],
}

VOLATILE_TOP_LEVEL_KEYS = {"trace_hash", "validation", "frontend_state"}


def canonicalize_trace(trace):
    """Return the stable semantic payload used for trace hashing."""
    return _canonical_value(trace, ())


def compute_trace_hash(trace):
    payload = json.dumps(canonicalize_trace(trace), sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def stamp_trace_contract(trace):
    trace.setdefault("schema_version", SCHEMA_VERSION)
    trace.setdefault("device_type", DEVICE_TYPE)
    trace.setdefault("run", {})
    trace.setdefault(
        "provenance",
        {
            "source": "QCCDSim",
            "generator": "trace_export.export_trace",
            "contract_version": SCHEMA_VERSION,
        },
    )
    trace.setdefault("timing_model", _model_with_hash(TIMING_MODEL))
    trace.setdefault("metric_model", _model_with_hash(METRIC_MODEL))
    trace["trace_hash"] = compute_trace_hash(trace)
    trace["run"].setdefault("id", f"run-{trace['trace_hash'][:16]}")
    return trace


def validate_trace_contract(trace):
    errors = []
    if not isinstance(trace, dict):
        return {"valid": False, "errors": ["trace must be an object"]}

    if trace.get("schema_version") != SCHEMA_VERSION:
        errors.append("unsupported schema_version")
    if trace.get("device_type") != DEVICE_TYPE:
        errors.append("unsupported device_type")

    _require_object(trace, "run", errors)
    _require_object(trace, "topology", errors)
    _require_object(trace, "timing", errors)
    _require_object(trace, "dag", errors)
    _require_object(trace, "metrics", errors)
    _require_array(trace, "particles", errors)
    _require_array(trace, "events", errors)
    _require_object(trace, "provenance", errors)
    _require_object(trace, "timing_model", errors)
    _require_object(trace, "metric_model", errors)

    run = trace.get("run") if isinstance(trace.get("run"), dict) else {}
    if not isinstance(run.get("id"), str) or not run.get("id"):
        errors.append("missing run.id")

    timing = trace.get("timing") if isinstance(trace.get("timing"), dict) else {}
    if timing.get("unit") != "us":
        errors.append("timing.unit must be us")
    cycle_time = timing.get("cycle_time_us")
    if not isinstance(cycle_time, (int, float)) or cycle_time <= 0:
        errors.append("timing.cycle_time_us must be positive")

    trace_hash = trace.get("trace_hash")
    if not isinstance(trace_hash, str) or not trace_hash:
        errors.append("missing trace_hash")
    elif trace_hash != compute_trace_hash(trace):
        errors.append("trace_hash mismatch")

    _validate_model_hash(trace.get("timing_model"), "timing_model", errors)
    _validate_model_hash(trace.get("metric_model"), "metric_model", errors)

    return {"valid": len(errors) == 0, "errors": errors}


def _canonical_value(value, path):
    if isinstance(value, dict):
        result = {}
        for key in sorted(value):
            if len(path) == 0 and key in VOLATILE_TOP_LEVEL_KEYS:
                continue
            if path == ("run",) and key == "id":
                continue
            result[key] = _canonical_value(value[key], (*path, key))
        return result
    if isinstance(value, list):
        return [_canonical_value(item, path) for item in value]
    return value


def _model_with_hash(model):
    stamped = copy.deepcopy(model)
    stamped["hash"] = _hash_model(model)
    return stamped


def _hash_model(model):
    payload = json.dumps(model, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _validate_model_hash(value, key, errors):
    if not isinstance(value, dict):
        return
    stored = value.get("hash")
    if not isinstance(stored, str) or not stored:
        errors.append(f"missing {key}.hash")
        return
    model = copy.deepcopy(value)
    model.pop("hash", None)
    if stored != _hash_model(model):
        errors.append(f"{key}.hash mismatch")


def _require_object(trace, key, errors):
    if key not in trace:
        errors.append(f"missing {key}")
    elif not isinstance(trace.get(key), dict):
        errors.append(f"{key} must be an object")


def _require_array(trace, key, errors):
    if key not in trace:
        errors.append(f"missing {key}")
    elif not isinstance(trace.get(key), list):
        errors.append(f"{key} must be an array")
