from pathlib import Path

import pytest

from parse import (
    CircuitValidationError,
    InputParse,
    SUPPORTED_BASIS,
    TRANSPILER_OPTIMIZATION_LEVEL,
    TRANSPILER_SEED,
    validate_openqasm_text,
)


ROOT = Path(__file__).resolve().parents[1]


def test_parser_flattens_multiple_quantum_registers(tmp_path):
    qasm = tmp_path / "multi_register.qasm"
    qasm.write_text(
        """
        OPENQASM 2.0;
        include "qelib1.inc";
        qreg a[2];
        qreg b[3];
        creg c[2];
        h a[0];
        rz(pi/2) b[1];
        cx a[1], b[2];
        measure b[2] -> c[0];
        barrier a, b;
        cx b[0], a[0];
        """,
        encoding="utf-8",
    )

    parser = InputParse()
    parser.parse_ir(str(qasm))

    assert parser.qbit_count == 5
    assert parser.qregs == {"a": (0, 2), "b": (2, 3)}
    assert list(parser.cx_gate_map.values()) == [[1, 4], [2, 0]]


def test_parser_accepts_qasmbench_multi_register_source():
    source = ROOT / "external_sources" / "QASMBench" / "small" / "adder_n10" / "adder_n10.qasm"
    parser = InputParse()
    parser.parse_ir(str(source))

    assert parser.qbit_count == 10
    assert len(parser.cx_gate_map) == 65


def test_parser_is_quiet_by_default(capsys):
    source = ROOT / "programs" / "test8q.qasm"
    parser = InputParse()
    parser.parse_ir(str(source))

    captured = capsys.readouterr()
    assert captured.out == ""


def test_parser_accepts_openqasm_text_and_reports_import_summary():
    qasm = """
    OPENQASM 2.0;
    include "qelib1.inc";
    qreg q[3];
    h q[0];
    rz(pi/4) q[1];
    cx q[0], q[2];
    """

    parser = InputParse()
    parser.parse_qasm_text(qasm)
    summary = validate_openqasm_text(qasm, source_label="inline qft slice")

    assert parser.qbit_count == 3
    assert parser.gate_name_map == {0: "h", 1: "rz", 2: "cx"}
    assert list(parser.cx_gate_map.values()) == [[0, 2]]
    assert summary["valid"] is True
    assert summary["id"].startswith("qasm:")
    assert summary["source_label"] == "inline qft slice"
    assert summary["qubits"] == 3
    assert summary["total_ops"] == 3
    assert summary["cx"] == 1
    assert summary["recommended_initial_load_cap"] == 1
    assert summary["supported_subset"] == "QCCDSim scheduling basis"
    assert summary["decomposition"] == {
        "basis_gates": SUPPORTED_BASIS,
        "optimization_level": TRANSPILER_OPTIMIZATION_LEVEL,
        "transpiler_seed": TRANSPILER_SEED,
    }
    assert "normalized_qasm_hash" in summary
    assert "dag_hash" in summary


def test_validate_openqasm_text_rejects_invalid_syntax():
    with pytest.raises(CircuitValidationError) as excinfo:
        validate_openqasm_text("OPENQASM 2.0; qreg q[2]; cx q[0], ;")

    assert excinfo.value.details
    assert "OpenQASM parse failed" in excinfo.value.details[0]


def test_validate_openqasm_text_rejects_unsupported_opaque_operation():
    qasm = """
    OPENQASM 2.0;
    opaque mystery q;
    qreg q[1];
    mystery q[0];
    """

    with pytest.raises(CircuitValidationError) as excinfo:
        validate_openqasm_text(qasm)

    assert any("Unsupported operation" in detail or "transpile failed" in detail for detail in excinfo.value.details)
