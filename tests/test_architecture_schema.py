import json
from pathlib import Path

import pytest

from architecture_builder import build_custom_machine
from architecture_schema import ArchitectureValidationError, validate_architecture_spec
from machine import MachineParams


FIXTURE_DIR = Path(__file__).parent / "fixtures" / "architectures"


def load_fixture(name):
    return json.loads((FIXTURE_DIR / name).read_text(encoding="utf-8"))


def test_valid_linear_architecture_normalizes_ports_and_layout():
    result = validate_architecture_spec(load_fixture("custom_linear_valid.json"))

    assert result["valid"] is True
    assert result["schema_version"] == "qccd_architecture_v1"
    assert result["id"] == "custom_linear_3"
    assert result["status"] == "graph_valid"
    assert result["scheduling_support"] == "qccdsim_machine_builder"
    assert result["warnings"] == []
    assert result["topology"]["traps"][1]["orientation"] == {"1": "L", "2": "R"}
    assert result["topology"]["layout"]["trap:2"]["x"] == 480


def test_valid_architecture_without_layout_gets_deterministic_preview_layout():
    result = validate_architecture_spec(load_fixture("custom_grid_no_layout_valid.json"))

    layout = result["topology"]["layout"]
    assert result["valid"] is True
    assert set(layout) == {"trap:0", "trap:1", "trap:2", "trap:3", "junction:0"}
    assert all("x" in point and "y" in point for point in layout.values())
    assert result["topology"]["junctions"][0]["degree"] == 4


@pytest.mark.parametrize(
    ("fixture", "expected"),
    [
        ("custom_invalid_duplicate_ids.json", "duplicate trap id 0"),
        ("custom_invalid_dangling_segment.json", "segment 0 references unknown junction 99"),
        ("custom_invalid_trap_port.json", "trap 0 port for segment 0 must use chain endpoint side L or R"),
        ("custom_invalid_junction_degree.json", "junction 0 declared degree 3 but graph degree is 2"),
    ],
)
def test_invalid_architectures_return_structured_errors(fixture, expected):
    with pytest.raises(ArchitectureValidationError) as excinfo:
        validate_architecture_spec(load_fixture(fixture))

    assert expected in excinfo.value.details


def test_invalid_architecture_rejects_non_dense_trap_ids():
    spec = load_fixture("custom_linear_valid.json")
    spec["traps"][2]["id"] = 4
    spec["segments"][3]["from"]["id"] = 4
    spec["layout"]["trap:4"] = spec["layout"].pop("trap:2")

    with pytest.raises(ArchitectureValidationError) as excinfo:
        validate_architecture_spec(spec)

    assert "trap ids must be dense zero-based integers: expected [0, 1, 2], got [0, 1, 4]" in excinfo.value.details


def test_invalid_architecture_rejects_parallel_duplicate_edges():
    spec = load_fixture("custom_linear_valid.json")
    spec["segments"].append(
        { "id": 4, "from": { "type": "trap", "id": 0 }, "to": { "type": "junction", "id": 0 }, "length": 10 }
    )
    spec["traps"][0]["ports"].append({ "segment": 4, "side": "R" })
    spec["junctions"][0]["degree"] = 3

    with pytest.raises(ArchitectureValidationError) as excinfo:
        validate_architecture_spec(spec)

    assert "segment 4 duplicates endpoint pair trap:0 -- junction:0" in excinfo.value.details


def test_invalid_architecture_rejects_disconnected_graph():
    spec = load_fixture("custom_linear_valid.json")
    spec["traps"].append(
        {
            "id": 3,
            "capacity": 2,
            "ports": [{ "segment": 4, "side": "L" }],
            "gate_zone": True,
            "storage_zones": [0, 1],
            "laser_accessible": True,
        }
    )
    spec["junctions"].append({ "id": 2, "degree": 2 })
    spec["segments"].extend(
        [
            { "id": 4, "from": { "type": "trap", "id": 3 }, "to": { "type": "junction", "id": 2 } },
            { "id": 5, "from": { "type": "junction", "id": 2 }, "to": { "type": "junction", "id": 2 } },
        ]
    )

    with pytest.raises(ArchitectureValidationError) as excinfo:
        validate_architecture_spec(spec)

    assert "architecture graph must be connected" in excinfo.value.details
    assert "segment 5 must not connect a node to itself" in excinfo.value.details


def test_builder_preserves_custom_graph_in_qccdsim_machine():
    machine = build_custom_machine(load_fixture("custom_linear_valid.json"), capacity=4, params=MachineParams())

    assert [trap.id for trap in machine.traps] == [0, 1, 2]
    assert [trap.capacity for trap in machine.traps] == [4, 4, 4]
    assert [junction.id for junction in machine.junctions] == [0, 1]
    assert [segment.id for segment in machine.segments] == [0, 1, 2, 3]
    assert machine.traps[0].orientation == {0: "R"}
    assert machine.traps[1].orientation == {1: "L", 2: "R"}
    assert machine.graph.degree(machine.junctions[0]) == 2
