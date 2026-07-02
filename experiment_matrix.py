import argparse
import csv
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from bottleneck_attribution import analyze_trace_bottlenecks
from comparison_metrics import trace_architecture_hash, trace_circuit_hash, trace_fidelity
from experiment_audit import write_experiment_audit
from simulation import (
    SIMULATION_SEED,
    SimulationConfig,
    run_simulation,
    supported_machine_names,
    supported_mapper_names,
    supported_reorder_policies,
    supported_scheduler_policies,
)
from trace_export import export_trace, write_trace
from visualizer_server import PROGRAMS, ROOT


METRIC_FIELDS = [
    "experiment_key",
    "program",
    "qubits",
    "cx_count",
    "architecture",
    "capacity",
    "mapper",
    "ordering",
    "scheduler",
    "seed",
    "trace_hash",
    "circuit_hash",
    "architecture_hash",
    "finish_time",
    "gate_time",
    "shuttling_time",
    "split_count",
    "move_count",
    "merge_count",
    "shuttle_count",
    "swap_count",
    "swap_hops",
    "ion_hops",
    "fidelity",
    "validation_status",
    "error_reason",
]

FAILURE_FIELDS = [
    "experiment_key",
    "program",
    "architecture",
    "capacity",
    "mapper",
    "ordering",
    "scheduler",
    "seed",
    "error_type",
    "error_reason",
]


@dataclass(frozen=True)
class ExperimentRunSpec:
    stream: str
    program: str
    machine: str
    capacity: int
    mapper: str
    ordering: str
    scheduler: str
    seed: int = SIMULATION_SEED

    @property
    def experiment_key(self):
        parts = [
            self.program,
            self.machine,
            f"cap{self.capacity}",
            self.mapper,
            self.ordering,
            self.scheduler,
            f"seed{self.seed}",
        ]
        return "__".join(_slug(part) for part in parts)


def load_experiment_config(path_or_config):
    if isinstance(path_or_config, (str, Path)):
        return json.loads(Path(path_or_config).read_text(encoding="utf-8-sig"))
    return dict(path_or_config)


def expand_experiment_matrix(config):
    config = load_experiment_config(config)
    stream = config.get("stream") or "qccd-research"
    matrix = config.get("matrix") or {}
    specs = []
    for program in _required_list(matrix, "circuits"):
        for machine in _required_list(matrix, "architectures"):
            _validate_member(machine, supported_machine_names(), "architecture")
            for capacity in _required_list(matrix, "capacities"):
                for mapper in _required_list(matrix, "mappers"):
                    _validate_member(mapper, supported_mapper_names(), "mapper")
                    for ordering in _required_list(matrix, "orderings"):
                        _validate_member(ordering, supported_reorder_policies(), "ordering")
                        for scheduler in _required_list(matrix, "schedulers"):
                            _validate_member(scheduler, supported_scheduler_policies(), "scheduler")
                            for seed in matrix.get("seeds") or [SIMULATION_SEED]:
                                specs.append(
                                    ExperimentRunSpec(
                                        stream=stream,
                                        program=str(program),
                                        machine=str(machine),
                                        capacity=int(capacity),
                                        mapper=str(mapper),
                                        ordering=str(ordering),
                                        scheduler=str(scheduler),
                                        seed=int(seed),
                                    )
                                )
    if len({spec.experiment_key for spec in specs}) != len(specs):
        raise ValueError("experiment matrix produced duplicate experiment keys")
    return specs


def run_experiment_matrix(config, output_root=Path("results/qccd_experiments"), timestamp=None):
    config = load_experiment_config(config)
    specs = expand_experiment_matrix(config)
    stream = config.get("stream") or "qccd-research"
    timestamp = timestamp or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output_dir = Path(output_root) / _slug(stream) / timestamp
    runs_dir = output_dir / "runs"
    analysis_dir = output_dir / "analysis"
    runs_dir.mkdir(parents=True, exist_ok=True)
    analysis_dir.mkdir(parents=True, exist_ok=True)

    manifest_runs = []
    metric_rows = []
    failure_rows = []
    for spec in specs:
        try:
            trace = _generate_trace(spec)
            analysis = analyze_trace_bottlenecks(trace)
            trace_path = runs_dir / f"{spec.experiment_key}.trace.json"
            analysis_path = analysis_dir / f"{spec.experiment_key}.analysis.json"
            write_trace(trace, trace_path)
            analysis_path.write_text(json.dumps(analysis, indent=2), encoding="utf-8")
            metric_rows.append(_metric_row(spec, trace))
            manifest_runs.append(
                {
                    "experiment_key": spec.experiment_key,
                    "status": "completed",
                    "trace_path": _relative_posix(output_dir, trace_path),
                    "analysis_path": _relative_posix(output_dir, analysis_path),
                    "trace_hash": trace.get("trace_hash"),
                }
            )
        except Exception as exc:  # pragma: no cover - exercised by research matrices, not smoke tests
            reason = str(exc)
            failure_rows.append(_failure_row(spec, type(exc).__name__, reason))
            manifest_runs.append(
                {
                    "experiment_key": spec.experiment_key,
                    "status": "failed",
                    "error_type": type(exc).__name__,
                    "error_reason": reason,
                }
            )

    _write_csv(output_dir / "metrics.csv", METRIC_FIELDS, metric_rows)
    _write_csv(output_dir / "failures.csv", FAILURE_FIELDS, failure_rows)
    manifest = {
        "stream": stream,
        "timestamp": timestamp,
        "config": config,
        "expected_runs": len(specs),
        "completed_runs": len(metric_rows),
        "failed_runs": len(failure_rows),
        "runs": manifest_runs,
    }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    audit = write_experiment_audit(output_dir)
    _write_summary(output_dir / "summary.md", manifest, audit)
    return {
        "output_dir": output_dir,
        "expected_runs": len(specs),
        "completed_runs": len(metric_rows),
        "failed_runs": len(failure_rows),
        "audit": audit,
    }


def _generate_trace(spec):
    program_path = _program_path(spec.program)
    result = run_simulation(
        SimulationConfig(
            program=program_path,
            machine=spec.machine,
            ions=spec.capacity,
            mapper=spec.mapper,
            reorder=spec.ordering,
            scheduler_policy=spec.scheduler,
            seed=spec.seed,
            source_label=spec.program,
        )
    )
    return export_trace(result)


def _program_path(program):
    if program in PROGRAMS:
        return str(ROOT / PROGRAMS[program]["path"])
    return str(program)


def _metric_row(spec, trace):
    metrics = trace.get("metrics") or {}
    counts = metrics.get("counts") or {}
    dag_nodes = (trace.get("dag") or {}).get("nodes") or []
    cx_count = sum(1 for node in dag_nodes if (node.get("gate_name") or "").lower() == "cx")
    qubits = sorted({qubit for node in dag_nodes for qubit in node.get("qubits") or []})
    split_count = _int(counts.get("split"))
    move_count = _int(counts.get("move"))
    merge_count = _int(counts.get("merge"))
    gate_time = _number((metrics.get("times") or {}).get("gate"))
    fidelity = trace_fidelity(trace)
    validation = trace.get("validation") or {}
    valid = validation.get("valid") is True
    return {
        "experiment_key": spec.experiment_key,
        "program": spec.program,
        "qubits": len(qubits),
        "cx_count": cx_count,
        "architecture": spec.machine,
        "capacity": spec.capacity,
        "mapper": spec.mapper,
        "ordering": spec.ordering,
        "scheduler": spec.scheduler,
        "seed": spec.seed,
        "trace_hash": trace.get("trace_hash"),
        "circuit_hash": trace_circuit_hash(trace),
        "architecture_hash": trace_architecture_hash(trace),
        "finish_time": _number(metrics.get("finish_time")),
        "gate_time": gate_time,
        "shuttling_time": _number(metrics.get("shuttling_time")),
        "split_count": split_count,
        "move_count": move_count,
        "merge_count": merge_count,
        "shuttle_count": split_count + move_count + merge_count,
        "swap_count": _int(metrics.get("swap_count")),
        "swap_hops": _int(metrics.get("swap_hops")),
        "ion_hops": _int(metrics.get("ion_hops")),
        "fidelity": fidelity,
        "validation_status": "valid" if valid else "invalid",
        "error_reason": "; ".join(str(error) for error in validation.get("errors") or []),
    }


def _failure_row(spec, error_type, reason):
    return {
        "experiment_key": spec.experiment_key,
        "program": spec.program,
        "architecture": spec.machine,
        "capacity": spec.capacity,
        "mapper": spec.mapper,
        "ordering": spec.ordering,
        "scheduler": spec.scheduler,
        "seed": spec.seed,
        "error_type": error_type,
        "error_reason": reason,
    }


def _write_summary(path, manifest, audit):
    lines = [
        "# QCCD Experiment Matrix",
        "",
        f"- Stream: `{manifest['stream']}`",
        f"- Timestamp: `{manifest['timestamp']}`",
        f"- Expected runs: {manifest['expected_runs']}",
        f"- Completed runs: {manifest['completed_runs']}",
        f"- Failed runs: {manifest['failed_runs']}",
        f"- Audit: {'PASS' if audit['valid'] else 'FAIL'}",
    ]
    if audit.get("errors"):
        lines.append("")
        lines.append("## Audit Errors")
        for error in audit["errors"]:
            lines.append(f"- {error}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _write_csv(path, fieldnames, rows):
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def _required_list(matrix, key):
    values = matrix.get(key)
    if not isinstance(values, list) or not values:
        raise ValueError(f"experiment matrix requires non-empty {key}")
    return values


def _validate_member(value, allowed, label):
    if value not in allowed:
        raise ValueError(f"unsupported {label}: {value}")


def _relative_posix(root, path):
    return Path(path).relative_to(root).as_posix()


def _slug(value):
    allowed = []
    for char in str(value):
        if char.isalnum() or char in {"-", "_", "."}:
            allowed.append(char)
        else:
            allowed.append("-")
    return "".join(allowed).strip("-") or "item"


def _number(value, default=0):
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return default
    if numeric != numeric:
        return default
    if numeric.is_integer():
        return int(numeric)
    return numeric


def _int(value):
    return int(_number(value))


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run a reproducible QCCD experiment matrix.")
    parser.add_argument("--config", required=True, help="Path to experiment matrix JSON.")
    parser.add_argument("--output-root", default="results/qccd_experiments", help="Directory for timestamped outputs.")
    parser.add_argument("--timestamp", default=None, help="Optional timestamp override for reproducible tests.")
    args = parser.parse_args(argv)
    result = run_experiment_matrix(args.config, output_root=args.output_root, timestamp=args.timestamp)
    print(json.dumps({"output_dir": str(result["output_dir"]), **{k: v for k, v in result.items() if k != "output_dir"}}, indent=2))
    return 0 if result["audit"]["valid"] else 1
