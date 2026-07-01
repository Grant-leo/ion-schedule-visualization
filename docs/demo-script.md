# Demo Script

This script is for a short live demonstration of the project.

## Setup

```powershell
.\venv\Scripts\python.exe visualizer_server.py --port 63200
```

Open:

```text
http://127.0.0.1:63200/
```

## Three-Minute Flow

1. Start with the default generated experiment.
2. Point out the three synchronized layers: hardware canvas, circuit strip, and dependency DAG.
3. Press `Play`.
4. Explain that ions split from trap-chain endpoints, move through channels and junctions, then merge back into trap chains.
5. Pause on a gate. Show that the laser highlight, circuit gate, and DAG node refer to the same operation.
6. Change the scheduler mode from `Parallel` to `Global serial`, then click `Generate Schedule`.
7. Show the headline time, shuttles, and fidelity changes.
8. Generate a second run and show the comparison panel.
9. Click `Export Bundle` to show that the demo can be turned into a reproducible experiment artifact.

## Suggested Narration

QCCD schedules are difficult to inspect from logs alone because the schedule is not only a sequence of gates. It also contains ion shuttling, chain split and merge operations, channel usage, junction usage, and hardware timing.

This visualizer replays the trace directly on a trap-and-channel architecture. The main canvas shows ion movement and laser gates, the top strip shows the corresponding circuit operations, and the right panel shows dependency progress. If a trace violates capacity, endpoint, resource, or DAG constraints, the page blocks playback and reports the reason.

For the hackathon, the prototype focuses on trapped-ion QCCD systems. It is designed as a research tool for debugging mappers, schedulers, and architectures, and for exporting reproducible schedule experiments.

## Backup Path

If live generation takes too long, switch to `Verified trace` and load one of the curated traces. The replay and validation path is the same after the trace is loaded.
