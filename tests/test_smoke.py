import subprocess
import sys
from pathlib import Path

from machine import MachineParams
from mappers import QubitMapGreedy
from parse import InputParse
from test_machines import make_linear_machine, make_single_hexagon_machine
from test_machines import test_trap_2x3 as make_trap_2x3


ROOT = Path(__file__).resolve().parents[1]


def make_machine_params():
    params = MachineParams()
    params.gate_type = "FM"
    params.swap_type = "GateSwap"
    params.split_merge_time = 80
    params.shuttle_time = 5
    params.junction2_cross_time = 5
    params.junction3_cross_time = 100
    params.junction4_cross_time = 120
    params.ion_swap_time = 42
    return params


def test_machine_factories_and_parser_smoke():
    params = make_machine_params()

    linear = make_linear_machine(6, 4, params)
    grid = make_trap_2x3(4, params)
    hexagon = make_single_hexagon_machine(4, params)

    assert (len(linear.traps), len(linear.junctions), len(linear.segments)) == (6, 5, 10)
    assert (len(grid.traps), len(grid.junctions), len(grid.segments)) == (6, 3, 8)
    assert (len(hexagon.traps), len(hexagon.junctions), len(hexagon.segments)) == (6, 6, 12)

    parser = InputParse()
    parser.parse_ir(str(ROOT / "programs" / "test8q.qasm"))

    assert parser.qbit_count == 8
    assert len(parser.cx_gate_map) == 7
    assert parser.gate_graph.number_of_edges() == 6


def test_run_py_executes_small_program():
    for dag_image in ROOT.glob("visualize_dag_test8q_L6_4_Greedy_Naive_FM_GateSwap_*.png"):
        dag_image.unlink()

    result = subprocess.run(
        [
            sys.executable,
            "run.py",
            "programs/test8q.qasm",
            "L6",
            "4",
            "Greedy",
            "Naive",
            "1",
            "0",
            "0",
            "FM",
            "GateSwap",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=60,
    )

    assert result.returncode == 0, result.stderr
    assert "Simulation" in result.stdout
    assert "SplitSWAP:" in result.stdout
    dag_images = list(ROOT.glob("visualize_dag_test8q_L6_4_Greedy_Naive_FM_GateSwap_*.png"))
    assert len(dag_images) == 1
    assert dag_images[0].stat().st_size > 0


def test_greedy_mapper_ignores_single_qubit_gate_nodes():
    parser = InputParse()
    parser.parse_ir(str(ROOT / "programs" / "bv64_cut.qasm"))

    machine = make_linear_machine(6, 14, make_machine_params())
    mapping = QubitMapGreedy(parser, machine).compute_mapping()

    mapped_qubits = {qubit for qubits in mapping.values() for qubit in qubits}
    assert mapped_qubits == set(range(8))


def test_run_batch_executes_with_current_python():
    output_log = ROOT / "output.log"
    output_log.unlink(missing_ok=True)
    for dag_image in ROOT.glob("visualize_dag_bv64_cut_L6_2_Greedy_Naive_FM_GateSwap_*.png"):
        dag_image.unlink()

    result = subprocess.run(
        [sys.executable, "run_batch.py"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=120,
    )

    assert result.returncode == 0, result.stderr
    assert "Traceback" not in result.stderr

    output = output_log.read_text()
    assert "Simulation" in output
    assert "SplitSWAP:" in output
    dag_images = list(ROOT.glob("visualize_dag_bv64_cut_L6_2_Greedy_Naive_FM_GateSwap_*.png"))
    assert len(dag_images) == 1
    assert dag_images[0].stat().st_size > 0
