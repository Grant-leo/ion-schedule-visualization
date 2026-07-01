# Import And Export Workflow

The visualizer supports three replay sources and one reproducibility export path.

## Replay Sources

| Source | Use Case |
| --- | --- |
| `Experiment` | Generate a fresh QCCDSim schedule from the page controls. |
| `Verified trace` | Load a curated local JSON trace from `visualizer/traces/`. |
| `Imported trace` | Load an external JSON trace and validate it against the trace contract. |

The three sources are mutually exclusive in the UI. This avoids mixing a generated configuration with a loaded trace that came from a different circuit or architecture.

## Circuit Import

OpenQASM import is available under `Experiment configuration`. The backend validates the circuit, records a normalized QASM hash, and then generates a trace through the same QCCDSim path used by built-in benchmarks.

Use this when you want the visualizer to run a new circuit through the current mapper, architecture, capacity, and scheduler controls.

## Architecture Import

Custom architecture import is also under `Experiment configuration`. The imported JSON is validated before it can be used for trace generation. A valid architecture must define traps, segments, junctions, and enough port information for channels to connect to legal trap endpoints.

Use this when testing a new QCCD layout before writing a full scheduling paper experiment.

## Experiment Bundle Export

Click `Export Bundle` after a trace has been generated or loaded. If a comparison pair is selected, the bundle exports both traces and the comparison result. Otherwise it exports the active trace.

The exported JSON contains:

- `bundle`: schema version, trace count, trace hashes, git commit, dependency snapshot, and bundle hash.
- `manifest`: circuit/DAG hashes, QASM hashes, architecture hashes, timing model hashes, metric model hashes, and validation states.
- `runs`: compact run metadata for each trace.
- `audit`: fresh validation and recomputed metrics for each trace.
- `comparison`: mapper or scheduler comparison when two compatible traces are exported.
- `command`: the UI configuration used at export time.
- `traces`: the full trace payloads.

This is a local browser download. No database, cloud upload, or hidden state is required.

## Recommended Review Procedure

1. Generate or load a trace.
2. Confirm the schedule is marked as verified.
3. Watch the first several split, move, merge, and gate events.
4. Check the DAG progress and headline metrics.
5. Generate a second run if comparing mappers or scheduler policies.
6. Export the bundle and attach it to the experiment note or issue.
