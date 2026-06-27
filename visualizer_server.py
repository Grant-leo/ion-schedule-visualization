import argparse
import json
from functools import lru_cache
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from simulation import SimulationConfig, run_simulation, supported_machine_names
from trace_export import export_trace


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "visualizer"

PROGRAMS = {
    "grover_n2": {
        "id": "grover_n2",
        "label": "Grover n2",
        "path": "programs/benchmarks/qasmbench/small/grover_n2.qasm",
    },
    "qft_n4": {
        "id": "qft_n4",
        "label": "QFT n4",
        "path": "programs/benchmarks/qasmbench/small/qft_n4.qasm",
    },
    "adder_n10": {
        "id": "adder_n10",
        "label": "Adder n10",
        "path": "programs/benchmarks/qasmbench/small/adder_n10.qasm",
    },
    "cat_state_n22": {
        "id": "cat_state_n22",
        "label": "Cat state n22",
        "path": "programs/benchmarks/qasmbench/medium/cat_state_n22.qasm",
    },
}

CAPACITIES = [1, 2, 3, 4, 5, 6, 8]
MAPPERS = ["Greedy", "Random", "LPFS", "Agg", "PO"]


def options_payload():
    return {
        "programs": list(PROGRAMS.values()),
        "machines": list(supported_machine_names()),
        "capacities": CAPACITIES,
        "mappers": MAPPERS,
        "defaults": {
            "program": "qft_n4",
            "machine": "G3x3",
            "capacity": 2,
            "mapper": "Greedy",
        },
    }


def generate_trace(program_id, machine, capacity, mapper):
    return json.loads(_generate_trace_json(program_id, machine, int(capacity), mapper))


@lru_cache(maxsize=64)
def _generate_trace_json(program_id, machine, capacity, mapper):
    if program_id not in PROGRAMS:
        raise ValueError(f"Unsupported program: {program_id}")
    if machine not in supported_machine_names():
        raise ValueError(f"Unsupported machine: {machine}")
    if capacity not in CAPACITIES:
        raise ValueError(f"Unsupported capacity: {capacity}")
    if mapper not in MAPPERS:
        raise ValueError(f"Unsupported mapper: {mapper}")

    config = SimulationConfig(
        program=str(ROOT / PROGRAMS[program_id]["path"]),
        machine=machine,
        ions=capacity,
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
    return json.dumps(export_trace(run_simulation(config)), separators=(",", ":"))


class VisualizerHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

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
            self._send_json(generate_trace(program_id, machine, capacity, mapper))
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
