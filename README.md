# QCCD Schedule Visual Debugger

This repository extends QCCDSim with an interactive visual debugger for trapped-ion QCCD schedules. The visualizer replays QCCDSim traces on hardware topology layouts, so ion shuttling, gate execution, dependency progress, and schedule metrics can be inspected together.

The original QCCDSim compiler and simulator is described in: https://ieeexplore.ieee.org/document/9138945

## What It Shows

- QCCD trap/channel topologies generated from QCCDSim machine definitions.
- Ion chains inside traps, with split, move, and merge operations animated along hardware paths.
- Laser-style highlighting for gate execution.
- A vertical Qiskit-derived dependency DAG that advances with schedule playback.
- Metrics for finish time, event count, 1Q/2Q gate mix, and shuttling burden.
- Architecture, trap-capacity, benchmark, mapper, initial-ordering, and scheduler-policy selection through the local visualizer API.
- Chain-internal swap cues before split operations when QCCDSim reports a required endpoint swap.

## Current Scope

The current prototype focuses on trapped-ion QCCD schedule inspection. It is a trace-level debugger: it checks topology consistency, ion locations, occupancy, event ordering, and schedule/DAG progress. It does not model noise, pulse-level control, calibration drift, or neutral-atom hardware.

## Quick Start

Create the Python environment and install dependencies:

```powershell
python -m venv venv
.\venv\Scripts\python.exe -m pip install -r requirements.txt
```

Start the visualizer server:

```powershell
.\venv\Scripts\python.exe visualizer_server.py --port 63200
```

Open:

```text
http://127.0.0.1:63200/
```

The default demo loads `qft_n4` on the `G3x3` QCCD architecture with trap capacity `2`, the `Greedy` mapper, `Naive` initial ordering, and the baseline EJF scheduler.

## Demo Flow

1. Open the visualizer and confirm the status badge shows `Schedule verified`.
2. Press `Play` to replay the schedule.
3. Watch ions split from trap-chain endpoints, shuttle through channels, and merge into destination traps.
4. Observe laser highlighting during gate execution.
5. Use the DAG panel to track completed, active, ready, and blocked operations.
6. Switch mapper, initial ordering, scheduler policy, architecture, or capacity, then regenerate the schedule.
7. Compare schedule metrics, especially `Shuttling burden`, finish time, and DAG progress, across configurations.

## Benchmarks

The demo catalog uses a representative QASMBench subset under `programs/benchmarks/qasmbench`. It includes search, Fourier, oracle, optimization, arithmetic, variational, linear-algebra, QEC, simulation, state-preparation, ML, overlap, and larger arithmetic circuits. `programs/benchmarks/qasmbench/manifest.csv` records source paths, hashes, qubit counts, operation counts, CX counts, and categories.

Static demo traces are stored in `visualizer/traces/` for fast loading, while `/api/trace` can generate fresh traces from selected configurations.

Supported visualizer options:

- Mappers: `Greedy`, `Random`, `LPFS`, `Agg`, `PO`, and deterministic `SABRE`-style placement.
- Initial ordering: `Naive` and `Fidelity`.
- Scheduler policies: `EJF`, `EJF-ParallelTrap`, `EJF-SerialComm`, and `EJF-GlobalSerial`.

To regenerate static traces:

```powershell
.\venv\Scripts\python.exe -B tools\generate_demo_traces.py
```

## Validation

Run the focused Python validation suite:

```powershell
.\venv\Scripts\python.exe -B -m pytest -q tests\test_trace_export.py tests\test_visualizer_server.py tests\test_visualizer_http.py tests\test_machine_topologies.py tests\test_demo_traces.py
```

Run the frontend unit tests:

```powershell
npm --prefix visualizer test
```

These tests cover topology uniqueness, trace validation, capacity preflight checks, HTTP API behavior, replay state, hardware path interpolation, DAG state, and presentation-safe UI summaries.
