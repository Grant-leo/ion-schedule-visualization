import csv
import json

from experiment_matrix import expand_experiment_matrix, load_experiment_config, run_experiment_matrix


def test_load_experiment_config_accepts_utf8_bom_files(tmp_path):
    config_path = tmp_path / "matrix.json"
    config_path.write_text(
        '\ufeff{"stream":"bom-smoke","matrix":{"circuits":["grover_n2"],"architectures":["L6"],"capacities":[2],"mappers":["Greedy"],"orderings":["Naive"],"schedulers":["EJF"],"seeds":[12345]}}',
        encoding="utf-8",
    )

    config = load_experiment_config(config_path)

    assert config["stream"] == "bom-smoke"
    assert len(expand_experiment_matrix(config)) == 1


def test_expand_experiment_matrix_creates_unique_run_specs():
    config = {
        "stream": "unit-smoke",
        "matrix": {
            "circuits": ["qft_n4", "grover_n2"],
            "architectures": ["L6"],
            "capacities": [2],
            "mappers": ["Greedy", "PO"],
            "orderings": ["Naive"],
            "schedulers": ["EJF"],
            "seeds": [11, 12],
        },
    }

    specs = expand_experiment_matrix(config)

    assert len(specs) == 8
    assert len({spec.experiment_key for spec in specs}) == len(specs)
    assert specs[0].program == "qft_n4"
    assert specs[0].machine == "L6"
    assert specs[0].capacity == 2
    assert specs[0].scheduler == "EJF"
    assert {spec.seed for spec in specs} == {11, 12}


def test_run_experiment_matrix_writes_manifest_metrics_failures_traces_and_analysis(tmp_path):
    config = {
        "stream": "unit-run",
        "matrix": {
            "circuits": ["grover_n2"],
            "architectures": ["L6"],
            "capacities": [2],
            "mappers": ["Greedy"],
            "orderings": ["Naive"],
            "schedulers": ["EJF"],
            "seeds": [999],
        },
    }

    result = run_experiment_matrix(config, output_root=tmp_path, timestamp="20260702-unit")

    output_dir = result["output_dir"]
    assert output_dir == tmp_path / "unit-run" / "20260702-unit"
    assert result["expected_runs"] == 1
    assert result["completed_runs"] == 1
    assert result["failed_runs"] == 0

    manifest = json.loads((output_dir / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["stream"] == "unit-run"
    assert manifest["expected_runs"] == 1
    assert manifest["completed_runs"] == 1
    assert manifest["runs"][0]["status"] == "completed"

    trace_path = output_dir / manifest["runs"][0]["trace_path"]
    analysis_path = output_dir / manifest["runs"][0]["analysis_path"]
    assert trace_path.exists()
    assert analysis_path.exists()

    trace = json.loads(trace_path.read_text(encoding="utf-8"))
    assert trace["run"]["seed"] == 999
    assert trace["validation"]["valid"] is True

    analysis = json.loads(analysis_path.read_text(encoding="utf-8"))
    assert analysis["trace_hash"] == trace["trace_hash"]
    assert analysis["attribution_model"]["name"] == "qccd-bottleneck-attribution"

    with (output_dir / "metrics.csv").open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    assert len(rows) == 1
    assert rows[0]["experiment_key"] == manifest["runs"][0]["experiment_key"]
    assert rows[0]["trace_hash"] == trace["trace_hash"]
    assert rows[0]["validation_status"] == "valid"
    assert float(rows[0]["finish_time"]) > 0

    with (output_dir / "failures.csv").open(newline="", encoding="utf-8") as handle:
        failures = list(csv.DictReader(handle))
    assert failures == []

    audit = json.loads((output_dir / "audit.json").read_text(encoding="utf-8"))
    assert audit["valid"] is True
    assert audit["expected_runs"] == 1
    assert audit["completed_runs"] == 1
    assert (output_dir / "summary.md").read_text(encoding="utf-8").startswith("# QCCD Experiment Matrix")
