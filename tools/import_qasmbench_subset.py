import csv
import hashlib
import shutil
from pathlib import Path

from qiskit import QuantumCircuit, transpile


REPO_URL = "https://github.com/pnnl/QASMBench"
SOURCE_ROOT = Path("external_sources/QASMBench")
OUTPUT_ROOT = Path("programs/benchmarks/qasmbench")

SELECTED = [
    ("small/grover_n2/grover_n2.qasm", "search", "Grover search smoke"),
    ("small/qft_n4/qft_n4.qasm", "fourier", "Small QFT smoke"),
    ("small/simon_n6/simon_n6.qasm", "oracle", "Simon's algorithm"),
    ("small/qaoa_n6/qaoa_n6.qasm", "optimization", "QAOA MaxCut-style circuit"),
    ("small/adder_n10/adder_n10.qasm", "arithmetic", "Ripple-carry adder"),
    ("small/vqe_n4/vqe_n4.qasm", "variational", "Small VQE"),
    ("medium/bv_n14/bv_n14.qasm", "oracle", "Bernstein-Vazirani star interactions"),
    ("medium/bigadder_n18/bigadder_n18.qasm", "arithmetic", "Larger adder"),
    ("medium/multiplier_n15/multiplier_n15.qasm", "arithmetic", "Multiplier"),
    ("medium/qft_n18/qft_n18.qasm", "fourier", "Medium QFT"),
    ("small/hhl_n7/hhl_n7.qasm", "linear_algebra", "HHL linear solver"),
    ("medium/qec9xz_n17/qec9xz_n17.qasm", "qec", "9-qubit X/Z error correction"),
    ("medium/ising_n26/ising_n26.qasm", "simulation", "Ising model simulation"),
    ("medium/cat_state_n22/cat_state_n22.qasm", "state_prep", "Cat state"),
    ("medium/ghz_state_n23/ghz_state_n23.qasm", "state_prep", "GHZ state"),
    ("medium/wstate_n27/wstate_n27.qasm", "state_prep", "W state"),
    ("medium/dnn_n16/dnn_n16.qasm", "ml", "Quantum neural network"),
    ("medium/swap_test_n25/swap_test_n25.qasm", "overlap", "Swap test"),
]

SUPPORTED_BASIS = ["rx", "ry", "rz", "h", "s", "sdg", "t", "tdg", "x", "y", "z", "cx"]


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    if not SOURCE_ROOT.exists():
        raise SystemExit(f"Missing {SOURCE_ROOT}. Clone QASMBench before importing.")

    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(SOURCE_ROOT / "LICENSE", OUTPUT_ROOT / "LICENSE_QASMBench.txt")

    rows = []
    for rel_source, category, note in SELECTED:
        source_path = SOURCE_ROOT / rel_source
        if not source_path.exists():
            raise SystemExit(f"Missing benchmark source: {source_path}")

        circuit = QuantumCircuit.from_qasm_file(str(source_path))
        scheduled = normalize_for_qccdsim(circuit)
        ops = scheduled.count_ops()

        tier, family, _ = rel_source.split("/", 2)
        output_dir = OUTPUT_ROOT / tier
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"{family}.qasm"
        source_url = f"{REPO_URL}/blob/master/{rel_source}"

        shutil.copyfile(source_path, output_path)

        rows.append(
            {
                "name": family,
                "category": category,
                "tier": tier,
                "local_path": output_path.as_posix(),
                "source_path": rel_source,
                "source_url": source_url,
                "source_sha256": sha256(source_path),
                "local_sha256": sha256(output_path),
                "scheduled_basis_sha256": hashlib.sha256(scheduled.qasm().encode("utf-8")).hexdigest(),
                "qubits": scheduled.num_qubits,
                "total_ops": sum(ops.values()),
                "cx": ops.get("cx", 0),
                "rx": ops.get("rx", 0),
                "ry": ops.get("ry", 0),
                "rz": ops.get("rz", 0),
                "recommended_l6_min_capacity": max(1, -(-scheduled.num_qubits // 6)),
                "note": note,
            }
        )

    manifest_path = OUTPUT_ROOT / "manifest.csv"
    with manifest_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

    readme = OUTPUT_ROOT / "README.md"
    readme.write_text(
        "# QASMBench Subset for QCCDSim\n\n"
        "Representative OpenQASM 2.0 circuits imported from QASMBench. Files are copied "
        "from QASMBench without flattening registers or stripping measurements. "
        "QCCDSim's parser uses Qiskit to parse/decompose the source into the scheduler "
        "basis: `rx`, `ry`, `rz`, `h`, `s`, `sdg`, `t`, `tdg`, `x`, `y`, `z`, and `cx`.\n\n"
        "Use `manifest.csv` for provenance, hashes, qubit counts, scheduled CX counts, "
        "and a minimum suggested `L6` trap capacity. QCCDSim schedules one-qubit and CX "
        "gates; measurements are preserved in source QASM but not timed by the current "
        "scheduler.\n\n"
        "Source: https://github.com/pnnl/QASMBench\n",
        encoding="utf-8",
    )

    print(f"Imported {len(rows)} benchmarks into {OUTPUT_ROOT}")
    print(f"Wrote {manifest_path}")


def normalize_for_qccdsim(circuit):
    transpiled = transpile(circuit, basis_gates=SUPPORTED_BASIS, optimization_level=0)
    flat = QuantumCircuit(transpiled.num_qubits, name=transpiled.name)

    for instruction in transpiled.data:
        operation = instruction.operation
        if operation.name in {"barrier", "measure"}:
            continue
        qubits = [flat.qubits[transpiled.find_bit(qubit).index] for qubit in instruction.qubits]
        flat.append(operation, qubits, [])

    return flat


if __name__ == "__main__":
    main()
