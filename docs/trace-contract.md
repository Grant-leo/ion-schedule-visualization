# QCCD Trace Contract

The visualizer uses a JSON trace contract as the boundary between QCCDSim, external schedulers, and the browser replay. A trace is not treated as a drawing script. It is a hardware-constrained schedule record that must describe topology, ions, events, dependencies, metrics, and validation state consistently.

## Required Top-Level Fields

| Field | Purpose |
| --- | --- |
| `schema_version` | Trace contract version. |
| `device_type` | Currently `ion_trap`. |
| `run` | Experiment configuration and reproducibility metadata. |
| `topology` | Trap, channel, junction, and layout description. |
| `timing` | Timing unit and cycle-to-microsecond scale. |
| `dag` | Gate-level dependency graph. |
| `particles` | Logical ion identities and initial locations. |
| `events` | Scheduled hardware operations. |
| `metrics` | Exported and recomputed schedule metrics. |
| `timing_model` | Hashable model descriptor for operation durations. |
| `metric_model` | Hashable model descriptor for metric semantics. |
| `trace_hash` | Stable content hash used for reproducibility. |
| `validation` | Contract, physics, DAG, and metrics validation result. |

## Topology Model

`topology.traps` describes the storage and gate regions. Each trap has a physical capacity, initial load capacity, slot count, and orientation map. The orientation map tells which segment reaches the left or right chain endpoint. This is important: shuttling may only split or merge ions at chain ends.

`topology.segments` describes channels between traps and junctions. `topology.junctions` describes channel branching resources. During replay, segment and junction occupancy is checked and highlighted separately.

`topology.layout` gives normalized renderer coordinates. The renderer may rotate trap drawings for readability, but it must preserve the port-to-endpoint relationship from the topology.

## Event Model

Supported event types are:

| Type | Meaning |
| --- | --- |
| `gate` | Laser-driven one- or two-qubit gate execution. |
| `split` | Endpoint ion leaves a trap chain into a segment. |
| `move` | Ion travels along a channel or through a junction route. |
| `merge` | Ion enters a trap chain at a legal endpoint. |

Each event includes `start`, `end`, `ions`, `source`, and `target`. Gate events should include `metadata.gate_id` so the circuit strip and DAG can highlight the same operation as the hardware canvas.

## Validation Rules

The validator blocks traces before playback when it detects:

- Unknown trap, segment, or junction locations.
- Movement over non-adjacent hardware resources.
- Trap capacity violations.
- Segment or junction resource conflicts.
- Split or merge operations that do not use chain endpoints.
- Ion location inconsistency across events.
- Overlapping operations on the same ion or trap.
- DAG dependency timing violations.
- Metrics that disagree with recomputed values.

This behavior is deliberate. The visualizer should not animate a physically inconsistent trace as if it were valid.

## Reproducibility Fields

The `run` object should include:

- `program`
- `machine`
- `mapper`
- `reorder`
- `scheduler_policy`
- `seed`
- `tie_break_policy`
- `initial_ions_per_region`
- `physical_ions_per_region`
- `communication_buffer_per_trap`

The trace hash is computed from canonical trace content. Volatile display-only fields are excluded so the hash remains stable across exports that do not change the schedule.
