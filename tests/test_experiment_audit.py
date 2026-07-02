import csv
import json

from experiment_audit import audit_experiment_run
from experiment_matrix import run_experiment_matrix


def test_audit_experiment_outputs_reloads_metrics_and_checks_coverage(tmp_path):
    config = {
        "stream": "audit-smoke",
        "matrix": {
            "circuits": ["grover_n2"],
            "architectures": ["L6"],
            "capacities": [2],
            "mappers": ["Greedy"],
            "orderings": ["Naive"],
            "schedulers": ["EJF"],
            "seeds": [12345],
        },
    }
    run = run_experiment_matrix(config, output_root=tmp_path, timestamp="20260702-audit")

    audit = audit_experiment_run(run["output_dir"])

    assert audit["valid"] is True
    assert audit["expected_runs"] == 1
    assert audit["completed_runs"] == 1
    assert audit["failed_runs"] == 0
    assert audit["metric_rows"] == 1
    assert audit["trace_files"] == 1
    assert audit["analysis_files"] == 1
    assert audit["errors"] == []


def test_audit_experiment_outputs_rejects_duplicate_metric_keys(tmp_path):
    config = {
        "stream": "audit-duplicate",
        "matrix": {
            "circuits": ["grover_n2"],
            "architectures": ["L6"],
            "capacities": [2],
            "mappers": ["Greedy"],
            "orderings": ["Naive"],
            "schedulers": ["EJF"],
            "seeds": [12345],
        },
    }
    run = run_experiment_matrix(config, output_root=tmp_path, timestamp="20260702-dup")
    metrics_path = run["output_dir"] / "metrics.csv"
    with metrics_path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        rows = list(reader)
        fieldnames = reader.fieldnames

    with metrics_path.open("a", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writerow(rows[0])

    audit = audit_experiment_run(run["output_dir"])

    assert audit["valid"] is False
    assert any("duplicate metrics experiment_key" in error for error in audit["errors"])
