import argparse

from simulation import SimulationConfig, run_simulation
from trace_export import export_trace, write_trace


def parse_args():
    parser = argparse.ArgumentParser(description="Export a QCCDSim schedule trace as JSON")
    parser.add_argument("program")
    parser.add_argument("output")
    parser.add_argument("--machine", default="L6")
    parser.add_argument("--ions", type=int, default=2)
    parser.add_argument("--mapper", default="Greedy")
    parser.add_argument("--reorder", default="Naive")
    parser.add_argument("--serial-trap-ops", type=int, default=1)
    parser.add_argument("--serial-comm", type=int, default=0)
    parser.add_argument("--serial-all", type=int, default=0)
    parser.add_argument("--gate-type", default="FM")
    parser.add_argument("--swap-type", default="GateSwap")
    parser.add_argument("--single-qubit-gate-time", type=int, default=7)
    parser.add_argument("--single-qubit-gate-fidelity", type=float, default=0.999)
    return parser.parse_args()


def main():
    args = parse_args()
    config = SimulationConfig(
        program=args.program,
        machine=args.machine,
        ions=args.ions,
        mapper=args.mapper,
        reorder=args.reorder,
        serial_trap_ops=args.serial_trap_ops,
        serial_comm=args.serial_comm,
        serial_all=args.serial_all,
        gate_type=args.gate_type,
        swap_type=args.swap_type,
        single_qubit_gate_time=args.single_qubit_gate_time,
        single_qubit_gate_fidelity=args.single_qubit_gate_fidelity,
    )
    trace = export_trace(run_simulation(config))
    output = write_trace(trace, args.output)
    print(output)


if __name__ == "__main__":
    main()
