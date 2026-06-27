from pathlib import Path

from parse import InputParse


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
