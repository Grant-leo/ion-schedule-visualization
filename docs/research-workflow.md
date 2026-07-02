# Research Workflow

The project is intended to grow from a visual demo into a QCCD algorithm research workbench. The current implementation already supports the core loop: generate a schedule, validate it, replay it, compare it, and export a reproducible bundle.

## Current Loop

1. Choose a benchmark circuit.
2. Choose a QCCD architecture and initial load capacity.
3. Choose mapper, initial ordering, and scheduler policy.
4. Generate a trace.
5. Inspect ion movement, trap-chain state, junction usage, circuit progress, and DAG progress.
6. Generate an alternative run.
7. Compare total time, shuttles, split/move/merge counts, swaps, ion travel proxy, channel pressure, DAG stall time, and fidelity.
8. Export an experiment bundle for review or reproduction.

## Batch Experiment Mode

For algorithm research, use the batch runner when a single replay is not enough. It expands a matrix over circuit, architecture, capacity, mapper, ordering, scheduler policy, and seed, then writes one trace and one bottleneck analysis file per run.

Smoke run:

```powershell
.\venv\Scripts\python.exe tools\run_experiment_matrix.py --config experiments\configs\qccd_research_smoke.json --output-root tmp\qccd_experiment_smoke
```

Core research matrix:

```powershell
.\venv\Scripts\python.exe tools\run_experiment_matrix.py --config experiments\configs\qccd_research_core.json --output-root results\qccd_experiments
```

Each timestamped output directory contains:

- `manifest.json`: matrix configuration, run status, trace paths, analysis paths, and trace hashes.
- `runs/*.trace.json`: validated QCCDSim trace contracts.
- `analysis/*.analysis.json`: post-hoc bottleneck attribution for traps, segments, junctions, ions, gate waits, and unexplained scheduler gaps.
- `metrics.csv`: one row per completed run with circuit hash, architecture hash, timing, shuttling, swap, ion-hop, fidelity, and validation fields.
- `failures.csv`: one row per failed run with the configuration and concrete error reason.
- `audit.json`: independent reload of the output directory checking coverage, duplicate keys, trace hashes, validation status, and analysis linkage.
- `summary.md`: compact human-readable status.

The default output root `results/` is ignored by Git so large experimental data does not accidentally enter the repository.

Experiment config files are ordinary JSON. On Windows, they may be edited with PowerShell commands such as `Set-Content -Encoding UTF8`; the loader accepts UTF-8 files with or without a byte-order mark.

## Verification Checklist

Before using a batch result for mapper or scheduler conclusions, check that the run directory contains:

- `manifest.json` with every intended configuration listed exactly once.
- `metrics.csv` rows for completed runs and `failures.csv` rows for rejected configurations.
- `audit.json` with `valid: true`.
- `analysis/*.analysis.json` files linked from the manifest for completed runs.
- Nonzero wait or pressure entries when the circuit and architecture should create contention.

The quickest end-to-end research sanity check is:

```powershell
.\venv\Scripts\python.exe tools\run_experiment_matrix.py --config experiments\configs\qccd_research_smoke.json --output-root tmp\qccd_experiment_smoke
.\venv\Scripts\python.exe -B -m pytest -q tests\test_experiment_matrix.py tests\test_experiment_audit.py tests\test_bottleneck_attribution.py
```

The smoke matrix covers two circuits and two scheduler policies. Use the core matrix when evaluating architecture, mapper, ordering, scheduler, and seed interactions.

## What To Look For

| Symptom | Likely Research Question |
| --- | --- |
| Repeated shuttling through the same channel | Is the mapper overloading one communication corridor? |
| Long DAG stalls | Are dependencies, trap occupancy, or channel resources blocking ready gates? |
| Many endpoint swaps before shuttling | Is the initial chain order poor for this circuit? |
| High channel pressure but low gate parallelism | Is the scheduler moving ions early without increasing useful gate concurrency? |
| Capacity validation failure | Does the architecture need more buffer capacity or a different placement? |

## External Scheduler Integration

External schedulers should emit the trace contract described in `docs/trace-contract.md`. Once the trace passes validation, the browser can replay it without needing to know how the schedule was produced.

For early integration, export:

- Trap/channel/junction topology.
- Initial ion placement.
- Event list with `gate`, `split`, `move`, and `merge` operations.
- DAG nodes and edges.
- Run metadata and timing model.

## Future Platform Direction

Planned extensions:

- Side-by-side synchronized replay for multiple schedulers.
- Editable architecture and circuit workspaces.
- External mapper and scheduler adapters.
- Breakthrough markers that highlight where a candidate policy improves time, shuttles, channel pressure, or dependency stalls.
- Larger batch experiment suites with paired conservative and exploratory streams.
- Exported reports that combine screenshots, metrics, traces, and comparison notes.

The design goal is a research platform where architecture design, mapping, scheduling, validation, visualization, and metrics use the same trace contract.
