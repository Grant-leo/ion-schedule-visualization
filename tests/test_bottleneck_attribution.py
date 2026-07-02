from bottleneck_attribution import analyze_trace_bottlenecks, build_resource_timeline


def _synthetic_trace():
    return {
        "trace_hash": "synthetic-hash",
        "topology": {
            "traps": [{"id": 0, "capacity": 2}, {"id": 1, "capacity": 2}],
            "junctions": [{"id": 0, "degree": 3, "junction_type": "J3"}],
            "segments": [
                {"id": 0, "from": "trap:0", "to": "junction:0"},
                {"id": 1, "from": "junction:0", "to": "trap:1"},
            ],
        },
        "dag": {
            "nodes": [
                {"id": 0, "gate_name": "h", "qubits": [0], "arity": 1},
                {"id": 1, "gate_name": "cx", "qubits": [0, 1], "arity": 2},
                {"id": 2, "gate_name": "h", "qubits": [1], "arity": 1},
            ],
            "edges": [{"source": 0, "target": 1}],
        },
        "events": [
            {
                "id": 0,
                "type": "gate",
                "start": 0,
                "end": 10,
                "source": "trap:0",
                "target": "trap:0",
                "ions": [0],
                "metadata": {"gate_id": 0, "gate_name": "h", "arity": 1},
            },
            {
                "id": 1,
                "type": "split",
                "start": 10,
                "end": 20,
                "source": "trap:0",
                "target": "segment:0",
                "ions": [0],
                "metadata": {"endpoint": "R"},
            },
            {
                "id": 2,
                "type": "move",
                "start": 20,
                "end": 35,
                "source": "segment:0",
                "target": "segment:1",
                "ions": [0],
                "metadata": {},
            },
            {
                "id": 3,
                "type": "merge",
                "start": 35,
                "end": 45,
                "source": "segment:1",
                "target": "trap:1",
                "ions": [0],
                "metadata": {"endpoint": "L"},
            },
            {
                "id": 4,
                "type": "gate",
                "start": 50,
                "end": 80,
                "source": "trap:1",
                "target": "trap:1",
                "ions": [0, 1],
                "metadata": {"gate_id": 1, "gate_name": "cx", "arity": 2},
            },
            {
                "id": 5,
                "type": "gate",
                "start": 5,
                "end": 12,
                "source": "trap:1",
                "target": "trap:1",
                "ions": [1],
                "metadata": {"gate_id": 2, "gate_name": "h", "arity": 1},
            },
        ],
    }


def test_resource_timeline_collects_gate_trap_segment_junction_and_ion_occupancy():
    timeline = build_resource_timeline(_synthetic_trace())

    assert timeline["trap:0"][0]["event_id"] == 0
    assert any(interval["event_id"] == 1 for interval in timeline["segment:0"])
    assert any(interval["event_id"] == 2 for interval in timeline["junction:0"])
    assert [interval["event_id"] for interval in timeline["ion:0"]] == [0, 1, 2, 3, 4]


def test_bottleneck_attribution_reports_dependency_ready_time_and_shuttle_wait_reason():
    analysis = analyze_trace_bottlenecks(_synthetic_trace())

    gate_one = next(item for item in analysis["gate_stalls"] if item["gate_id"] == 1)
    assert gate_one["dependency_ready_time"] == 10
    assert gate_one["scheduled_start"] == 50
    assert gate_one["wait_time"] == 40
    assert gate_one["primary_wait_reason"] == "ion_not_colocated"
    assert "ion:0" in gate_one["blocking_resources"]

    gate_two = next(item for item in analysis["gate_stalls"] if item["gate_id"] == 2)
    assert gate_two["dependency_ready_time"] == 0
    assert gate_two["wait_time"] == 5
    assert gate_two["primary_wait_reason"] == "scheduler_gap_unknown"

    assert analysis["top_resource_hotspots"][0]["resource"] == "ion:0"
    assert analysis["summary"]["total_gate_wait_time"] == 45
