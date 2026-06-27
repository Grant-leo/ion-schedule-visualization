# QASMBench Subset for QCCDSim

Representative OpenQASM 2.0 circuits imported from QASMBench. Files are copied from QASMBench without flattening registers or stripping measurements. QCCDSim's parser uses Qiskit to parse/decompose the source into the scheduler basis: `rx`, `ry`, `rz`, `h`, `s`, `sdg`, `t`, `tdg`, `x`, `y`, `z`, and `cx`.

Use `manifest.csv` for provenance, hashes, qubit counts, scheduled CX counts, and a minimum suggested `L6` trap capacity. QCCDSim schedules one-qubit and CX gates; measurements are preserved in source QASM but not timed by the current scheduler.

Source: https://github.com/pnnl/QASMBench
