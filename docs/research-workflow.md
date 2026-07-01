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
- Batch experiment mode for benchmark suites.
- Exported reports that combine screenshots, metrics, traces, and comparison notes.

The design goal is a research platform where architecture design, mapping, scheduling, validation, visualization, and metrics use the same trace contract.
