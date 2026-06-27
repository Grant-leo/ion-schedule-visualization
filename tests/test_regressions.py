import subprocess
import sys
import importlib

import pytest

from dag_visualize import dag_image_name
from mappers import QubitMapAgg, QubitMapGreedy, QubitMapMetis, QubitMapPO
from naive_schedule import create_routing_graph, routing_graph
from parse import InputParse
from route import RouteAlgorithm
from test_machines import (
    make_3x3_grid,
    make_9trap,
    mktrap4x2,
    mktrap6x3,
    mktrap8x4,
    mktrap_4star,
    make_linear_machine,
)

from tests.test_smoke import ROOT, make_machine_params


def test_dag_image_name_is_unique_per_run_context():
    first = dag_image_name(
        "programs/test8q.qasm",
        "L6",
        4,
        "PO",
        "Naive",
        "FM",
        "GateSwap",
        pid=123,
    )
    second = dag_image_name(
        "programs/test8q.qasm",
        "L6",
        4,
        "Agg",
        "Naive",
        "FM",
        "GateSwap",
        pid=456,
    )

    assert first != second
    assert first.name == "visualize_dag_test8q_L6_4_PO_Naive_FM_GateSwap_123.png"
    assert second.name == "visualize_dag_test8q_L6_4_Agg_Naive_FM_GateSwap_456.png"


def test_legacy_machine_factories_still_construct():
    factories = [
        mktrap4x2,
        mktrap_4star,
        mktrap6x3,
        mktrap8x4,
        make_3x3_grid,
        make_9trap,
    ]

    for factory in factories:
        machine = factory(4)
        assert machine.traps
        assert machine.segments
        assert machine.junctions


def test_single_qubit_only_circuit_runs_end_to_end(tmp_path):
    qasm = tmp_path / "single_only.qasm"
    qasm.write_text(
        """
        OPENQASM 2.0;
        include "qelib1.inc";
        qreg q[3];
        h q[0];
        x q[1];
        rz(pi/2) q[2];
        """,
        encoding="utf-8",
    )

    result = subprocess.run(
        [
            sys.executable,
            str(ROOT / "run.py"),
            str(qasm),
            "L6",
            "4",
            "Greedy",
            "Naive",
            "1",
            "0",
            "0",
            "FM",
            "GateSwap",
            "7",
            "0.999",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=60,
    )

    assert result.returncode == 0, result.stderr + result.stdout
    assert "OPCOUNTS Gate: 3 1QGate: 3 2QGate: 0" in result.stdout
    assert "Gate: 21 1QGate: 21 2QGate: 0" in result.stdout


def test_all_local_mappers_cover_every_program_qubit():
    parser = InputParse()
    parser.parse_ir(str(ROOT / "programs" / "test8q.qasm"))
    machine = make_linear_machine(6, 4, make_machine_params())

    mapping_by_qubit = QubitMapPO(parser, machine).compute_mapping()
    assert set(mapping_by_qubit) == set(range(parser.qbit_count))

    agg_mapping = QubitMapAgg(parser, machine).compute_mapping()
    assert set(agg_mapping) == set(range(parser.qbit_count))

    greedy_mapping = QubitMapGreedy(parser, machine).compute_mapping()
    greedy_qubits = {qubit for qubits in greedy_mapping.values() for qubit in qubits}
    assert greedy_qubits == set(range(parser.qbit_count))


def test_metis_mapper_fails_with_actionable_dependency_message():
    parser = InputParse()
    parser.parse_ir(str(ROOT / "programs" / "test8q.qasm"))
    machine = make_linear_machine(6, 4, make_machine_params())

    with pytest.raises(ImportError, match="pymetis or metis"):
        QubitMapMetis(parser, machine).compute_mapping()


def test_project_modules_import_without_side_effect_failures():
    modules = [
        "analyzer",
        "dag_visualize",
        "ejf_schedule",
        "gen",
        "gen_qaoa_maxcut",
        "machine",
        "machine_state",
        "mappers",
        "naive_schedule",
        "parse",
        "parse_output",
        "rebalance",
        "route",
        "schedule",
        "sorted_collection",
        "test_machines",
        "utils",
    ]

    for module in modules:
        importlib.import_module(module)


def test_route_algorithm_uses_current_machine_graph_shape():
    machine = make_linear_machine(3, 4, make_machine_params())
    router = RouteAlgorithm(machine)

    assert router.find_route(0, 2) == ["T0", "S0", "S1", "T1", "S2", "S3", "T2"]


def test_naive_schedule_routing_graph_uses_current_machine_graph_shape():
    machine = make_linear_machine(3, 4, make_machine_params())

    create_routing_graph(machine)

    assert ("T0", "S0") in routing_graph.edges
    assert ("S0", "S1") in routing_graph.edges
    assert ("T1", "S2") in routing_graph.edges
