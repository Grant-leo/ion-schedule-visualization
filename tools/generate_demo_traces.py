import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from simulation import SimulationConfig, run_simulation
from trace_export import export_trace, write_trace


TRACE_DIR = ROOT / "visualizer" / "traces"


DEMOS = [
    {
        "id": "grover_n2_l6_greedy",
        "label": "grover n2 | L6 | load 1 | phys 3 | Greedy",
        "program": "programs/benchmarks/qasmbench/small/grover_n2.qasm",
        "machine": "L6",
        "ions": 1,
        "mapper": "Greedy",
    },
    {
        "id": "adder_n10_l6_greedy",
        "label": "adder n10 | L6 | load 3 | phys 5 | Greedy",
        "program": "programs/benchmarks/qasmbench/small/adder_n10.qasm",
        "machine": "L6",
        "ions": 3,
        "mapper": "Greedy",
    },
    {
        "id": "adder_n10_l6_random",
        "label": "adder n10 | L6 | load 3 | phys 5 | Random",
        "program": "programs/benchmarks/qasmbench/small/adder_n10.qasm",
        "machine": "L6",
        "ions": 3,
        "mapper": "Random",
    },
    {
        "id": "cat_state_n22_l6_greedy",
        "label": "cat state n22 | L6 | load 4 | phys 6 | Greedy",
        "program": "programs/benchmarks/qasmbench/medium/cat_state_n22.qasm",
        "machine": "L6",
        "ions": 4,
        "mapper": "Greedy",
    },
]

for machine in ["L6", "H6", "G2x3", "T4x2", "T6x3", "T8x4", "G3x3", "G9"]:
    DEMOS.append(
        {
            "id": f"qft_n4_{machine.lower()}_greedy",
            "label": f"qft n4 | {machine} | load 2 | phys 4 | Greedy",
            "program": "programs/benchmarks/qasmbench/small/qft_n4.qasm",
            "machine": machine,
            "ions": 2,
            "mapper": "Greedy",
        }
    )


def main():
    TRACE_DIR.mkdir(parents=True, exist_ok=True)
    for stale_trace in TRACE_DIR.glob("*.json"):
        stale_trace.unlink()
    manifest = []
    for demo in DEMOS:
        config = SimulationConfig(
            program=str(ROOT / demo["program"]),
            machine=demo["machine"],
            ions=demo["ions"],
            mapper=demo["mapper"],
            reorder="Naive",
            serial_trap_ops=1,
            serial_comm=0,
            serial_all=0,
            gate_type="FM",
            swap_type="GateSwap",
            single_qubit_gate_time=7,
            single_qubit_gate_fidelity=0.999,
        )
        output = TRACE_DIR / f"{demo['id']}.json"
        trace = export_trace(run_simulation(config))
        write_trace(trace, output)
        run = trace["run"]
        manifest.append(
            {
                "id": demo["id"],
                "label": demo["label"],
                "path": f"traces/{demo['id']}.json",
                "program": demo["program"],
                "machine": demo["machine"],
                "ions_per_region": run["ions_per_region"],
                "physical_ions_per_region": run["physical_ions_per_region"],
                "communication_buffer_per_trap": run["communication_buffer_per_trap"],
                "mapper": demo["mapper"],
            }
        )
    (TRACE_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"generated {len(manifest)} traces")


if __name__ == "__main__":
    main()
