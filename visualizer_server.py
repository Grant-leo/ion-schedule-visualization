import argparse
import csv
import json
from functools import lru_cache
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from parse import InputParse
from simulation import (
    SimulationConfig,
    build_machine,
    run_simulation,
    scheduler_policy_flags,
    scheduler_policy_options,
    supported_machine_names,
    supported_mapper_names,
    supported_reorder_policies,
    supported_scheduler_policies,
)
from trace_export import export_trace


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "visualizer"
QASMBENCH_MANIFEST = ROOT / "programs" / "benchmarks" / "qasmbench" / "manifest.csv"

PROGRAMS = {}

CAPACITIES = [1, 2, 3, 4, 5, 6, 8]
MAPPERS = list(supported_mapper_names())
ORDERINGS = list(supported_reorder_policies())
SCHEDULERS = list(supported_scheduler_policies())


def options_payload():
    return {
        "programs": list(PROGRAMS.values()),
        "machines": list(supported_machine_names()),
        "capacities": CAPACITIES,
        "mappers": MAPPERS,
        "orderings": ORDERINGS,
        "schedulers": SCHEDULERS,
        "scheduler_options": scheduler_policy_options(),
        "defaults": {
            "program": "qft_n4",
            "machine": "G3x3",
            "capacity": 2,
            "mapper": "Greedy",
            "ordering": "Naive",
            "scheduler": "EJF",
        },
    }


def generate_trace(program_id, machine, capacity, mapper, ordering="Naive", scheduler="EJF"):
    return json.loads(_generate_trace_json(program_id, machine, int(capacity), mapper, ordering, scheduler))


@lru_cache(maxsize=64)
def _generate_trace_json(program_id, machine, capacity, mapper, ordering, scheduler):
    if program_id not in PROGRAMS:
        raise ValueError(f"Unsupported program: {program_id}")
    if machine not in supported_machine_names():
        raise ValueError(f"Unsupported machine: {machine}")
    if capacity not in CAPACITIES:
        raise ValueError(f"Unsupported capacity: {capacity}")
    if mapper not in MAPPERS:
        raise ValueError(f"Unsupported mapper: {mapper}")
    if ordering not in ORDERINGS:
        raise ValueError(f"Unsupported ordering: {ordering}")
    if scheduler not in SCHEDULERS:
        raise ValueError(f"Unsupported scheduler: {scheduler}")
    _validate_demo_capacity(program_id, machine, capacity)
    serial_trap_ops, serial_comm, serial_all = scheduler_policy_flags(scheduler)

    config = SimulationConfig(
        program=str(ROOT / PROGRAMS[program_id]["path"]),
        machine=machine,
        ions=capacity,
        mapper=mapper,
        reorder=ordering,
        serial_trap_ops=serial_trap_ops,
        serial_comm=serial_comm,
        serial_all=serial_all,
        scheduler_policy=scheduler,
        gate_type="FM",
        swap_type="GateSwap",
        single_qubit_gate_time=7,
        single_qubit_gate_fidelity=0.999,
    )
    return json.dumps(export_trace(run_simulation(config)), separators=(",", ":"))


def _validate_demo_capacity(program_id, machine, capacity):
    qubits = _program_qubit_count(program_id)
    slots = _machine_trap_count(machine, capacity) * capacity
    if qubits > slots:
        raise ValueError(
            f"{PROGRAMS[program_id]['label']} requires {qubits} logical qubits, "
            f"but {machine} with capacity {capacity} provides {slots} ion slots"
        )


@lru_cache(maxsize=32)
def _program_qubit_count(program_id):
    qubits = PROGRAMS[program_id].get("qubits")
    if isinstance(qubits, int):
        return qubits
    parser = InputParse()
    parser.parse_ir(str(ROOT / PROGRAMS[program_id]["path"]))
    return parser.qbit_count


@lru_cache(maxsize=64)
def _machine_trap_count(machine, capacity):
    config = SimulationConfig(program="unused.qasm", machine=machine, ions=capacity)
    return len(build_machine(config).traps)


class VisualizerHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/options":
            self._send_json(options_payload())
            return
        if parsed.path == "/api/trace":
            self._handle_trace(parse_qs(parsed.query))
            return
        super().do_GET()

    def _handle_trace(self, query):
        try:
            program_id = _single(query, "program")
            machine = _single(query, "machine")
            capacity = int(_single(query, "capacity"))
            mapper = _single(query, "mapper")
            ordering = _optional(query, "ordering", "Naive")
            scheduler = _optional(query, "scheduler", "EJF")
            self._send_json(generate_trace(program_id, machine, capacity, mapper, ordering, scheduler))
        except Exception as exc:
            self._send_json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)

    def _send_json(self, payload, status=HTTPStatus.OK):
        body = json.dumps(payload, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def _single(query, key):
    values = query.get(key)
    if not values or values[0] == "":
        raise ValueError(f"Missing query parameter: {key}")
    return values[0]


def _optional(query, key, default):
    values = query.get(key)
    if not values or values[0] == "":
        return default
    return values[0]


def _load_program_catalog():
    if not QASMBENCH_MANIFEST.exists():
        return _fallback_program_catalog()

    programs = {}
    with QASMBENCH_MANIFEST.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            program_id = row["name"]
            programs[program_id] = {
                "id": program_id,
                "label": _program_label(program_id),
                "path": row["local_path"],
                "category": row["category"],
                "tier": row["tier"],
                "qubits": int(row["qubits"]),
                "total_ops": int(row["total_ops"]),
                "cx": int(row["cx"]),
                "recommended_l6_min_capacity": int(row["recommended_l6_min_capacity"]),
                "source": "QASMBench",
                "source_url": row.get("source_url", ""),
                "note": row.get("note", ""),
            }
    tier_rank = {"small": 0, "medium": 1, "large": 2}
    return dict(
        sorted(
            programs.items(),
            key=lambda item: (tier_rank.get(item[1]["tier"], 99), item[1]["category"], item[0]),
        )
    )


def _fallback_program_catalog():
    return {
        "grover_n2": {
            "id": "grover_n2",
            "label": "Grover n2",
            "path": "programs/benchmarks/qasmbench/small/grover_n2.qasm",
            "category": "search",
            "tier": "small",
        },
        "qft_n4": {
            "id": "qft_n4",
            "label": "QFT n4",
            "path": "programs/benchmarks/qasmbench/small/qft_n4.qasm",
            "category": "fourier",
            "tier": "small",
        },
    }


def _program_label(program_id):
    acronyms = {"qft": "QFT", "qaoa": "QAOA", "qec": "QEC", "vqe": "VQE", "hhl": "HHL", "bv": "BV"}
    parts = program_id.split("_")
    return " ".join(acronyms.get(part, part.capitalize()) for part in parts)


PROGRAMS.update(_load_program_catalog())


def parse_args():
    parser = argparse.ArgumentParser(description="Serve the QCCD ion schedule visualizer")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=63200)
    return parser.parse_args()


def main():
    args = parse_args()
    server = ThreadingHTTPServer((args.host, args.port), VisualizerHandler)
    print(f"Serving QCCD visualizer at http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
