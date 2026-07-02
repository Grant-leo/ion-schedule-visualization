import csv
import json
from pathlib import Path

from trace_contract import compute_trace_hash


def audit_experiment_run(output_dir):
    output_dir = Path(output_dir)
    errors = []
    manifest = _read_json(output_dir / "manifest.json", errors, "manifest")
    metric_rows = _read_csv(output_dir / "metrics.csv", errors, "metrics")
    failure_rows = _read_csv(output_dir / "failures.csv", errors, "failures")

    expected_runs = _int(manifest.get("expected_runs"))
    completed_runs = _int(manifest.get("completed_runs"))
    failed_runs = _int(manifest.get("failed_runs"))
    run_records = manifest.get("runs") if isinstance(manifest.get("runs"), list) else []

    if expected_runs != completed_runs + failed_runs:
        errors.append("manifest expected_runs does not equal completed_runs + failed_runs")
    if len(run_records) != completed_runs + failed_runs:
        errors.append("manifest run record count does not match completed_runs + failed_runs")

    _check_unique_keys([row.get("experiment_key") for row in metric_rows], "metrics experiment_key", errors)
    _check_unique_keys([row.get("experiment_key") for row in failure_rows], "failures experiment_key", errors)
    _check_unique_keys([record.get("experiment_key") for record in run_records], "manifest experiment_key", errors)

    trace_files = 0
    analysis_files = 0
    metrics_by_key = {row.get("experiment_key"): row for row in metric_rows}
    failures_by_key = {row.get("experiment_key"): row for row in failure_rows}

    for record in run_records:
        if not isinstance(record, dict):
            errors.append("manifest run record must be an object")
            continue
        key = record.get("experiment_key")
        status = record.get("status")
        if status == "completed":
            if key not in metrics_by_key:
                errors.append(f"missing metrics row for completed run {key}")
            trace_path = output_dir / str(record.get("trace_path", ""))
            analysis_path = output_dir / str(record.get("analysis_path", ""))
            if not trace_path.exists():
                errors.append(f"missing trace file for {key}: {record.get('trace_path')}")
                continue
            trace_files += 1
            trace = _read_json(trace_path, errors, f"trace {key}")
            if trace:
                _audit_trace(key, trace, metrics_by_key.get(key, {}), errors)
            if not analysis_path.exists():
                errors.append(f"missing analysis file for {key}: {record.get('analysis_path')}")
            else:
                analysis_files += 1
                analysis = _read_json(analysis_path, errors, f"analysis {key}")
                if analysis and trace:
                    if analysis.get("trace_hash") != trace.get("trace_hash"):
                        errors.append(f"analysis trace_hash mismatch for {key}")
        elif status == "failed":
            if key not in failures_by_key:
                errors.append(f"missing failure row for failed run {key}")
        else:
            errors.append(f"unknown manifest status for {key}: {status}")

    if len(metric_rows) != completed_runs:
        errors.append("metrics row count does not match completed_runs")
    if len(failure_rows) != failed_runs:
        errors.append("failure row count does not match failed_runs")

    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "expected_runs": expected_runs,
        "completed_runs": completed_runs,
        "failed_runs": failed_runs,
        "metric_rows": len(metric_rows),
        "failure_rows": len(failure_rows),
        "trace_files": trace_files,
        "analysis_files": analysis_files,
    }


def write_experiment_audit(output_dir):
    output_dir = Path(output_dir)
    audit = audit_experiment_run(output_dir)
    (output_dir / "audit.json").write_text(json.dumps(audit, indent=2), encoding="utf-8")
    return audit


def _audit_trace(key, trace, metrics, errors):
    validation = trace.get("validation") if isinstance(trace.get("validation"), dict) else {}
    if validation.get("valid") is not True:
        errors.append(f"trace validation failed for {key}")
    trace_hash = trace.get("trace_hash")
    if trace_hash != compute_trace_hash(trace):
        errors.append(f"trace_hash mismatch for {key}")
    if metrics:
        if metrics.get("trace_hash") != trace_hash:
            errors.append(f"metrics trace_hash mismatch for {key}")
        if metrics.get("validation_status") != "valid":
            errors.append(f"metrics validation_status is not valid for {key}")


def _read_json(path, errors, label):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        errors.append(f"missing {label}: {path.name}")
    except json.JSONDecodeError as exc:
        errors.append(f"invalid {label} json: {exc}")
    return {}


def _read_csv(path, errors, label):
    try:
        with path.open(newline="", encoding="utf-8") as handle:
            return list(csv.DictReader(handle))
    except FileNotFoundError:
        errors.append(f"missing {label}: {path.name}")
        return []


def _check_unique_keys(keys, label, errors):
    seen = set()
    for key in keys:
        if not key:
            errors.append(f"missing {label}")
            continue
        if key in seen:
            errors.append(f"duplicate {label}: {key}")
        seen.add(key)


def _int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0
