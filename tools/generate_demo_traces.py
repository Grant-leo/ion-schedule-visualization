import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from simulation import SimulationConfig, run_simulation
from trace_export import export_trace, write_trace


TRACE_DIR = ROOT / "visualizer" / "traces"


DEMOS = [
    ("grover_n2_greedy", "programs/benchmarks/qasmbench/small/grover_n2.qasm", 1, "Greedy"),
    ("qft_n4_greedy", "programs/benchmarks/qasmbench/small/qft_n4.qasm", 2, "Greedy"),
    ("adder_n10_greedy", "programs/benchmarks/qasmbench/small/adder_n10.qasm", 3, "Greedy"),
    ("adder_n10_random", "programs/benchmarks/qasmbench/small/adder_n10.qasm", 3, "Random"),
    ("cat_state_n22_greedy", "programs/benchmarks/qasmbench/medium/cat_state_n22.qasm", 4, "Greedy"),
]


def main():
    TRACE_DIR.mkdir(parents=True, exist_ok=True)
    manifest = []
    for name, program, ions, mapper in DEMOS:
        config = SimulationConfig(
            program=str(ROOT / program),
            machine="L6",
            ions=ions,
            mapper=mapper,
            reorder="Naive",
            serial_trap_ops=1,
            serial_comm=0,
            serial_all=0,
            gate_type="FM",
            swap_type="GateSwap",
            single_qubit_gate_time=7,
            single_qubit_gate_fidelity=0.999,
        )
        output = TRACE_DIR / f"{name}.json"
        trace = export_trace(run_simulation(config))
        write_trace(trace, output)
        manifest.append({"id": name, "label": name.replace("_", " "), "path": f"traces/{name}.json"})
    (TRACE_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"generated {len(manifest)} traces")


if __name__ == "__main__":
    main()
