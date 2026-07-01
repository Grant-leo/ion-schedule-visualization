import argparse
import csv
import json
from functools import lru_cache
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from architecture_schema import ArchitectureValidationError, validate_architecture_spec
from external_trace_adapter import ExternalTraceError, adapt_external_trace
from parse import CircuitValidationError, InputParse, validate_openqasm_text
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
VISUALIZER_UNSAFE_SCHEDULERS = {"EJF-ParallelTrap"}
VISUALIZER_SCHEDULERS = [policy for policy in SCHEDULERS if policy not in VISUALIZER_UNSAFE_SCHEDULERS]
MAX_IMPORT_BYTES = 2_000_000
VISUALIZER_SCHEDULER_LABELS = {
    "EJF": "Parallel schedule",
    "EJF-SerialComm": "Serial shuttling",
    "EJF-GlobalSerial": "Serial schedule",
}


def options_payload():
    return {
        "programs": list(PROGRAMS.values()),
        "machines": list(supported_machine_names()),
        "machine_trap_counts": {machine: _machine_trap_count(machine, 1) for machine in supported_machine_names()},
        "capacities": CAPACITIES,
        "mappers": MAPPERS,
        "orderings": ORDERINGS,
        "schedulers": VISUALIZER_SCHEDULERS,
        "scheduler_options": _visualizer_scheduler_options(),
        "defaults": {
            "program": "swap_test_n25",
            "machine": "G3x3",
            "capacity": 3,
            "mapper": "SABRE",
            "ordering": "Naive",
            "scheduler": "EJF",
        },
    }


def _visualizer_scheduler_options():
    return [
        {**option, "label": VISUALIZER_SCHEDULER_LABELS.get(option["id"], option["label"])}
        for option in scheduler_policy_options()
        if option["id"] in VISUALIZER_SCHEDULERS
    ]


def generate_trace(program_id, machine, capacity, mapper, ordering="Naive", scheduler="EJF"):
    trace = json.loads(_generate_trace_json(program_id, machine, int(capacity), mapper, ordering, scheduler))
    validation = trace.get("validation") or {}
    if not validation.get("valid", False):
        errors = "; ".join((validation.get("errors") or [])[:4]) or "unknown validation error"
        raise ValueError(f"Generated trace failed validation: {errors}")
    return trace


def generate_custom_trace(payload):
    if not isinstance(payload, dict):
        raise ValueError("Custom trace request must be an object")
    architecture_spec = payload.get("architecture")
    if architecture_spec is None:
        raise ValueError("Missing custom architecture payload")
    normalized_architecture = validate_architecture_spec(architecture_spec)
    program_id = str(payload.get("program") or "")
    capacity = int(payload.get("capacity"))
    mapper = str(payload.get("mapper") or "")
    ordering = str(payload.get("ordering") or "Naive")
    scheduler = str(payload.get("scheduler") or "EJF")
    _validate_custom_trace_options(program_id, capacity, mapper, ordering, scheduler, normalized_architecture)
    serial_trap_ops, serial_comm, serial_all = scheduler_policy_flags(scheduler)

    config = SimulationConfig(
        program=str(ROOT / PROGRAMS[program_id]["path"]),
        machine=f"CUSTOM:{normalized_architecture['id']}",
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
        architecture_spec=architecture_spec,
    )
    trace = export_trace(run_simulation(config))
    validation = trace.get("validation") or {}
    if not validation.get("valid", False):
        errors = "; ".join((validation.get("errors") or [])[:4]) or "unknown validation error"
        raise ValueError(f"Generated custom trace failed validation: {errors}")
    return trace


def validate_imported_circuit(payload):
    if not isinstance(payload, dict):
        raise CircuitValidationError(["Circuit request must be an object"])
    return validate_openqasm_text(payload.get("qasm"), payload.get("source_label") or "Imported circuit")


def generate_imported_circuit_trace(payload):
    if not isinstance(payload, dict):
        raise ValueError("Imported circuit trace request must be an object")
    summary = validate_imported_circuit(payload)
    machine = str(payload.get("machine") or "")
    capacity = int(payload.get("capacity"))
    mapper = str(payload.get("mapper") or "")
    ordering = str(payload.get("ordering") or "Naive")
    scheduler = str(payload.get("scheduler") or "EJF")
    _validate_imported_circuit_trace_options(summary, machine, capacity, mapper, ordering, scheduler)
    serial_trap_ops, serial_comm, serial_all = scheduler_policy_flags(scheduler)

    config = SimulationConfig(
        program=f"IMPORTED:{summary['id']}",
        program_text=payload.get("qasm"),
        source_label=summary["source_label"],
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
    trace = export_trace(run_simulation(config))
    validation = trace.get("validation") or {}
    if not validation.get("valid", False):
        errors = "; ".join((validation.get("errors") or [])[:4]) or "unknown validation error"
        raise ValueError(f"Generated imported circuit trace failed validation: {errors}")
    return trace


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
    if scheduler not in VISUALIZER_SCHEDULERS:
        raise ValueError(f"Unsupported visualizer scheduler: {scheduler}")
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
    trap_count = _machine_trap_count(machine, capacity)
    slots = trap_count * capacity
    if qubits > slots:
        raise ValueError(
            f"{PROGRAMS[program_id]['label']} requires {qubits} logical qubits, "
            f"but {machine} with initial load cap {capacity} provides {slots} initial ion slots"
        )
    recommended_capacity = int(PROGRAMS[program_id].get("recommended_l6_min_capacity") or 1) if machine == "L6" else 1
    required_capacity = max((qubits + max(1, trap_count) - 1) // max(1, trap_count), recommended_capacity)
    if capacity < required_capacity:
        raise ValueError(
            f"{PROGRAMS[program_id]['label']} requires demo-safe initial load cap {required_capacity} "
            f"for this benchmark; {machine} with initial load cap {capacity} can fit {slots} total ions but may "
            "produce invalid intermediate trap occupancy"
        )


def _validate_custom_trace_options(program_id, capacity, mapper, ordering, scheduler, normalized_architecture):
    if program_id not in PROGRAMS:
        raise ValueError(f"Unsupported program: {program_id}")
    if capacity not in CAPACITIES:
        raise ValueError(f"Unsupported capacity: {capacity}")
    if mapper not in MAPPERS:
        raise ValueError(f"Unsupported mapper: {mapper}")
    if ordering not in ORDERINGS:
        raise ValueError(f"Unsupported ordering: {ordering}")
    if scheduler not in VISUALIZER_SCHEDULERS:
        raise ValueError(f"Unsupported visualizer scheduler: {scheduler}")
    qubits = _program_qubit_count(program_id)
    trap_count = len(normalized_architecture["topology"]["traps"])
    slots = trap_count * capacity
    if qubits > slots:
        raise ValueError(
            f"{PROGRAMS[program_id]['label']} requires {qubits} logical qubits, "
            f"but custom architecture {normalized_architecture['id']} with initial load cap {capacity} "
            f"provides {slots} initial ion slots"
        )


def _validate_imported_circuit_trace_options(summary, machine, capacity, mapper, ordering, scheduler):
    if machine not in supported_machine_names():
        raise ValueError(f"Unsupported machine: {machine}")
    if capacity not in CAPACITIES:
        raise ValueError(f"Unsupported capacity: {capacity}")
    if mapper not in MAPPERS:
        raise ValueError(f"Unsupported mapper: {mapper}")
    if ordering not in ORDERINGS:
        raise ValueError(f"Unsupported ordering: {ordering}")
    if scheduler not in VISUALIZER_SCHEDULERS:
        raise ValueError(f"Unsupported visualizer scheduler: {scheduler}")
    trap_count = _machine_trap_count(machine, capacity)
    slots = trap_count * capacity
    qubits = int(summary["qubits"])
    if qubits > slots:
        raise ValueError(
            f"{summary['source_label']} requires {qubits} logical qubits, "
            f"but {machine} with initial load cap {capacity} provides {slots} initial ion slots"
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

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/import/trace":
            self._handle_import_trace()
            return
        if parsed.path == "/api/circuit/validate":
            self._handle_circuit_validate()
            return
        if parsed.path == "/api/trace":
            self._handle_imported_circuit_trace()
            return
        if parsed.path == "/api/architecture/validate":
            self._handle_architecture_validate()
            return
        if parsed.path == "/api/trace/custom":
            self._handle_custom_trace()
            return
        self._send_json({"error": "Unsupported endpoint"}, status=HTTPStatus.NOT_FOUND)

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

    def _handle_import_trace(self):
        payload = self._read_json_payload("Imported trace payload is too large")
        if payload is None:
            return
        try:
            self._send_json(adapt_external_trace(payload))
        except ExternalTraceError as exc:
            self._send_json({"error": str(exc), "details": exc.details}, status=HTTPStatus.BAD_REQUEST)

    def _handle_architecture_validate(self):
        payload = self._read_json_payload("Architecture payload is too large")
        if payload is None:
            return
        try:
            self._send_json(validate_architecture_spec(payload))
        except ArchitectureValidationError as exc:
            self._send_json({"error": str(exc), "details": exc.details}, status=HTTPStatus.BAD_REQUEST)

    def _handle_circuit_validate(self):
        payload = self._read_json_payload("Circuit payload is too large")
        if payload is None:
            return
        try:
            self._send_json(validate_imported_circuit(payload))
        except CircuitValidationError as exc:
            self._send_json({"error": str(exc), "details": exc.details}, status=HTTPStatus.BAD_REQUEST)

    def _handle_imported_circuit_trace(self):
        payload = self._read_json_payload("Imported circuit trace payload is too large")
        if payload is None:
            return
        try:
            self._send_json(generate_imported_circuit_trace(payload))
        except CircuitValidationError as exc:
            self._send_json({"error": str(exc), "details": exc.details}, status=HTTPStatus.BAD_REQUEST)
        except Exception as exc:
            self._send_json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)

    def _handle_custom_trace(self):
        payload = self._read_json_payload("Custom trace payload is too large")
        if payload is None:
            return
        try:
            self._send_json(generate_custom_trace(payload))
        except ArchitectureValidationError as exc:
            self._send_json({"error": str(exc), "details": exc.details}, status=HTTPStatus.BAD_REQUEST)
        except Exception as exc:
            self._send_json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)

    def _read_json_payload(self, too_large_error):
        content_type = self.headers.get("Content-Type", "")
        if not content_type.lower().split(";")[0].strip() == "application/json":
            self._send_json({"error": "Unsupported content type"}, status=HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
            return None
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json({"error": "Invalid Content-Length"}, status=HTTPStatus.BAD_REQUEST)
            return None
        if content_length > MAX_IMPORT_BYTES:
            self._send_json({"error": too_large_error}, status=HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            return None
        try:
            body = self.rfile.read(content_length)
            return json.loads(body.decode("utf-8"))
        except json.JSONDecodeError as exc:
            self._send_json({"error": f"Malformed JSON: {exc.msg}"}, status=HTTPStatus.BAD_REQUEST)
            return None

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
    return " ".join(acronyms.get(part, part if part.startswith("n") and part[1:].isdigit() else part.capitalize()) for part in parts)


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
