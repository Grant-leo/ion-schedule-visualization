import hashlib
import json
import math

from trace_audit import recompute_trace_metrics


LOWER_IS_BETTER = "lower"
HIGHER_IS_BETTER = "higher"


METRIC_DEFINITIONS = [
    ("total_time", "Total time", LOWER_IS_BETTER),
    ("shuttles", "Shuttles", LOWER_IS_BETTER),
    ("split_count", "Splits", LOWER_IS_BETTER),
    ("move_count", "Moves", LOWER_IS_BETTER),
    ("merge_count", "Merges", LOWER_IS_BETTER),
    ("swap_count", "Swaps", LOWER_IS_BETTER),
    ("ion_travel", "Ion travel proxy", LOWER_IS_BETTER),
    ("channel_pressure", "Channel pressure", LOWER_IS_BETTER),
    ("dag_stall_time", "DAG stall time", LOWER_IS_BETTER),
    ("fidelity", "Estimated fidelity", HIGHER_IS_BETTER),
]


def compare_traces(baseline, candidate):
    compatibility = _compatibility(baseline, candidate)
    if compatibility["reasons"]:
        return {
            "valid": False,
            "status": "non_comparable",
            "reasons": compatibility["reasons"],
            "flags": compatibility["flags"],
            "compatibility": compatibility,
            "rows": [],
        }

    baseline_metrics = _comparison_metrics(baseline)
    candidate_metrics = _comparison_metrics(candidate)
    rows = [
        _metric_row(metric, label, direction, baseline_metrics[metric], candidate_metrics[metric])
        for metric, label, direction in METRIC_DEFINITIONS
    ]
    delta_markers = _delta_markers(rows, baseline, candidate)
    return {
        "valid": True,
        "status": "comparable",
        "reasons": [],
        "flags": compatibility["flags"],
        "compatibility": compatibility,
        "baseline": _run_summary(baseline),
        "candidate": _run_summary(candidate),
        "rows": rows,
        "delta_markers": delta_markers,
    }


def _compatibility(baseline, candidate):
    reasons = []
    flags = []
    _append_validation_reasons(reasons, "baseline", baseline)
    _append_validation_reasons(reasons, "candidate", candidate)

    baseline_circuit = _circuit_hash(baseline)
    candidate_circuit = _circuit_hash(candidate)
    if baseline_circuit != candidate_circuit:
        reasons.append("circuit DAG differs")

    baseline_architecture = _architecture_hash(baseline)
    candidate_architecture = _architecture_hash(candidate)
    if baseline_architecture != candidate_architecture:
        reasons.append("architecture differs")

    baseline_timing = _model_hash(baseline, "timing_model")
    candidate_timing = _model_hash(candidate, "timing_model")
    if baseline_timing and candidate_timing and baseline_timing != candidate_timing:
        reasons.append("timing model differs")

    baseline_metric = _model_hash(baseline, "metric_model")
    candidate_metric = _model_hash(candidate, "metric_model")
    if baseline_metric and candidate_metric and baseline_metric != candidate_metric:
        reasons.append("metric model differs")

    if _run_value(baseline, "seed") != _run_value(candidate, "seed"):
        flags.append("seed_mismatch")
    if _run_value(baseline, "tie_break_policy") != _run_value(candidate, "tie_break_policy"):
        flags.append("tie_break_mismatch")

    return {
        "circuit_hash": baseline_circuit if baseline_circuit == candidate_circuit else None,
        "baseline_circuit_hash": baseline_circuit,
        "candidate_circuit_hash": candidate_circuit,
        "architecture_hash": baseline_architecture if baseline_architecture == candidate_architecture else None,
        "baseline_architecture_hash": baseline_architecture,
        "candidate_architecture_hash": candidate_architecture,
        "timing_model_hash": baseline_timing if baseline_timing == candidate_timing else None,
        "metric_model_hash": baseline_metric if baseline_metric == candidate_metric else None,
        "reasons": reasons,
        "flags": flags,
    }


def _comparison_metrics(trace):
    exported_metrics = trace.get("metrics") or {}
    metrics = recompute_trace_metrics(trace)
    if "fidelity" in exported_metrics:
        metrics["fidelity"] = exported_metrics["fidelity"]
    counts = metrics.get("counts") or {}
    split_count = _number(counts.get("split"))
    move_count = _number(counts.get("move"))
    merge_count = _number(counts.get("merge"))
    return {
        "total_time": _number(metrics.get("finish_time")),
        "shuttles": split_count + move_count + merge_count,
        "split_count": split_count,
        "move_count": move_count,
        "merge_count": merge_count,
        "swap_count": _number(metrics.get("swap_count")),
        "ion_travel": _number(metrics.get("ion_hops")),
        "channel_pressure": _channel_pressure(trace),
        "dag_stall_time": _dag_stall_time(trace),
        "fidelity": _fidelity(trace),
    }


def _metric_row(metric, label, direction, baseline, candidate):
    delta = candidate - baseline
    if baseline == 0:
        delta_percent = None
    else:
        delta_percent = delta / baseline
    if math.isclose(delta, 0, abs_tol=1e-12):
        winner = "tie"
    elif direction == LOWER_IS_BETTER:
        winner = "candidate" if delta < 0 else "baseline"
    else:
        winner = "candidate" if delta > 0 else "baseline"
    return {
        "metric": metric,
        "label": label,
        "direction": direction,
        "baseline": baseline,
        "candidate": candidate,
        "delta": delta,
        "delta_percent": delta_percent,
        "winner": winner,
    }


def _delta_markers(rows, baseline, candidate):
    markers = []
    row_by_metric = {row["metric"]: row for row in rows}
    for metric, kind_prefix in [("total_time", "time"), ("shuttles", "shuttling"), ("channel_pressure", "channel_pressure")]:
        row = row_by_metric.get(metric)
        if not row or math.isclose(row["delta"], 0, abs_tol=1e-12):
            continue
        direction = "improvement" if row["winner"] == "candidate" else "regression"
        markers.append(
            {
                "kind": f"{kind_prefix}_{direction}",
                "metric": metric,
                "baseline": row["baseline"],
                "candidate": row["candidate"],
                "delta": row["delta"],
            }
        )
    markers.extend(_resource_delta_markers(baseline, candidate))
    return markers


def _resource_delta_markers(baseline, candidate):
    baseline_segments = _resource_duration_map(_trace_bottlenecks(baseline).get("segments"))
    candidate_segments = _resource_duration_map(_trace_bottlenecks(candidate).get("segments"))
    markers = []
    for resource in sorted(set(baseline_segments) | set(candidate_segments)):
        baseline_duration = baseline_segments.get(resource, 0)
        candidate_duration = candidate_segments.get(resource, 0)
        delta = candidate_duration - baseline_duration
        if math.isclose(delta, 0, abs_tol=1e-12):
            continue
        markers.append(
            {
                "kind": "resource_improvement" if delta < 0 else "resource_regression",
                "metric": "segment_duration",
                "resource": resource,
                "baseline": baseline_duration,
                "candidate": candidate_duration,
                "delta": delta,
            }
        )
    return sorted(markers, key=lambda item: (-abs(item["delta"]), item["resource"]))[:5]


def _trace_bottlenecks(trace):
    return recompute_trace_metrics(trace).get("bottlenecks") or {}


def _resource_duration_map(items):
    result = {}
    for item in items or []:
        if isinstance(item, dict) and item.get("resource"):
            result[item["resource"]] = _number(item.get("duration"))
    return result


def _channel_pressure(trace):
    events = [event for event in trace.get("events") or [] if event.get("type") in {"split", "move", "merge"}]
    pressure = 0
    for event in events:
        duration = max(0, _number(event.get("end")) - _number(event.get("start")))
        pressure += duration * len(_event_segment_resources(event))
    return pressure


def _event_segment_resources(event):
    event_type = event.get("type")
    if event_type == "split" and _is_segment(event.get("target")):
        return [event.get("target")]
    if event_type == "merge" and _is_segment(event.get("source")):
        return [event.get("source")]
    if event_type == "move":
        return sorted({loc for loc in [event.get("source"), event.get("target")] if _is_segment(loc)})
    return []


def _is_segment(location):
    return isinstance(location, str) and location.startswith("segment:")


def _dag_stall_time(trace):
    gate_windows = {}
    for event in trace.get("events") or []:
        if event.get("type") != "gate":
            continue
        gate_id = event.get("metadata", {}).get("gate_id")
        if gate_id is not None:
            gate_windows[int(gate_id)] = (_number(event.get("start")), _number(event.get("end")))

    total_wait = 0
    for edge in (trace.get("dag") or {}).get("edges") or []:
        source = int(edge.get("source"))
        target = int(edge.get("target"))
        if source not in gate_windows or target not in gate_windows:
            continue
        _, source_end = gate_windows[source]
        target_start, _ = gate_windows[target]
        total_wait += max(0, target_start - source_end)
    return total_wait


def _fidelity(trace):
    metrics_fidelity = _bounded_fidelity((trace.get("metrics") or {}).get("fidelity"))
    if metrics_fidelity is not None:
        return metrics_fidelity
    product = 1.0
    for event in trace.get("events") or []:
        product *= _event_fidelity_factor(event, trace)
    return product


def _event_fidelity_factor(event, trace):
    metadata = event.get("metadata") or {}
    metadata_fidelity = _bounded_fidelity(metadata.get("fidelity"))
    if metadata_fidelity is not None:
        return metadata_fidelity
    run = trace.get("run") or {}
    event_type = event.get("type")
    if event_type == "gate":
        arity = _number(metadata.get("arity") or len(event.get("ions") or []), 1)
        default = 0.999 if arity == 1 else 0.992
        base = _bounded_fidelity(run.get("single_qubit_gate_fidelity" if arity == 1 else "two_qubit_gate_fidelity"))
        duration_penalty = max(0, _number(event.get("end")) - _number(event.get("start"))) / 1_000_000
        return max(0.0001, (base if base is not None else default) - duration_penalty)
    if event_type == "split":
        swap_count = _number(metadata.get("swap_count"))
        if swap_count > 0:
            swap_gate = _bounded_fidelity(run.get("two_qubit_gate_fidelity")) or 1
            return swap_gate ** (swap_count * 3)
        return _bounded_fidelity(run.get("split_fidelity") or run.get("shuttle_fidelity")) or 1
    if event_type == "move":
        return _bounded_fidelity(run.get("move_fidelity") or run.get("shuttle_fidelity")) or 1
    if event_type == "merge":
        return _bounded_fidelity(run.get("merge_fidelity") or run.get("shuttle_fidelity")) or 1
    return 1


def _bounded_fidelity(value):
    numeric = _optional_number(value)
    if numeric is None:
        return None
    return min(1, max(0.0001, numeric))


def _circuit_hash(trace):
    dag = trace.get("dag") or {}
    payload = {
        "nodes": sorted(
            [
                {
                    "id": node.get("id"),
                    "gate_name": node.get("gate_name"),
                    "qubits": node.get("qubits") or [],
                    "arity": node.get("arity"),
                }
                for node in dag.get("nodes") or []
            ],
            key=lambda node: node["id"],
        ),
        "edges": sorted(
            [
                {"source": edge.get("source"), "target": edge.get("target")}
                for edge in dag.get("edges") or []
            ],
            key=lambda edge: (edge["source"], edge["target"]),
        ),
    }
    return _stable_hash(payload)


def _model_hash(trace, key):
    model = trace.get(key) or {}
    return model.get("hash") if isinstance(model, dict) else None


def _architecture_hash(trace):
    stored = trace.get("architecture_hash")
    if isinstance(stored, str) and stored:
        return stored
    payload = {
        "machine": _run_value(trace, "machine"),
        "topology": trace.get("topology") or {},
    }
    return _stable_hash(payload)


def _run_summary(trace):
    run = trace.get("run") or {}
    return {
        "id": run.get("id"),
        "program": run.get("program"),
        "machine": run.get("machine"),
        "mapper": run.get("mapper"),
        "scheduler_policy": run.get("scheduler_policy"),
    }


def _run_value(trace, key):
    run = trace.get("run") or {}
    return run.get(key)


def _append_validation_reasons(reasons, label, trace):
    validation = trace.get("validation")
    if not isinstance(validation, dict):
        reasons.append(f"{label} validation missing")
        return
    if validation.get("valid") is not True:
        errors = validation.get("errors") if isinstance(validation.get("errors"), list) else []
        suffix = f": {'; '.join(str(error) for error in errors[:3])}" if errors else ""
        reasons.append(f"{label} validation failed{suffix}")


def _stable_hash(payload):
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


def _optional_number(value):
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    return numeric if math.isfinite(numeric) else None


def _number(value, default=0):
    numeric = _optional_number(value)
    return default if numeric is None else numeric
