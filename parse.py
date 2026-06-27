'''
Parser for OpenQASM inputs.

QCCDSim schedules two-qubit interactions, but benchmark QASM often contains
multiple qregs, whole-register gates, custom gates, and measurements.  Use
Qiskit to parse/decompose OpenQASM 2.0, then build the compact dependency
objects expected by the mapper and scheduler:
    cx_graph: weighted undirected qubit interaction graph
    cx_gate_map: two-qubit gate id -> [qubit1, qubit2]
    gate_graph: operation dependency DAG
'''

import sys

import networkx as nx
from qiskit import QuantumCircuit, transpile


SINGLE_QUBIT_GATES = {'x', 'y', 'z', 'h', 's', 'sdg', 't', 'tdg', 'rx', 'ry', 'rz'}
TWO_QUBIT_GATES = {'cx'}
SUPPORTED_BASIS = sorted(SINGLE_QUBIT_GATES | TWO_QUBIT_GATES)


class InputParse:
    def __init__(self, verbose=False):
        self.verbose = verbose
        self.cx_graph = nx.Graph()
        self.cx_graph.graph['edge_weight_attr'] = 'weight'
        self.cx_graph.graph['node_weight_attr'] = 'node_weight'
        self.edge_weights = {}
        self.prev_gate = {}
        self.global_gate_id = 0
        self.cx_gate_map = {}
        self.gate_qubit_map = {}
        self.gate_name_map = {}
        self.gate_graph = nx.DiGraph()
        self.gset = sorted(SINGLE_QUBIT_GATES | TWO_QUBIT_GATES)
        self.qbit_count = 0
        self.qregs = {}
        self.cregs = {}
        self.two_qubit_gate_list = []

    def find_dep_gate(self, qbit):
        if qbit in self.prev_gate.keys():
            return [self.prev_gate[qbit]]
        else:
            return []

    def update_dep_gate(self, qbit, gate_id):
        self.prev_gate[qbit] = gate_id

    def check_valid_gate(self, line):
        return self._gate_name(line) in self.gset

    def add_edge_pair(self, q1, q2):
        c = min(q1, q2)
        t = max(q1, q2)
        if not c in self.edge_weights.keys():
            self.edge_weights[c] = {}
        if not t in self.edge_weights[c].keys():
            self.edge_weights[c][t] = 0
        self.edge_weights[c][t] += 1
        self.cx_graph.add_edge(c, t)
        self.cx_graph.adj[c][t]['weight'] = self.edge_weights[c][t]
        self.cx_graph.nodes[c]['node_weight'] = 1
        self.cx_graph.nodes[t]['node_weight'] = 1

    def process_gate(self, line):
        # Retained for compatibility with callers that exercised the old parser.
        raise NotImplementedError("process_gate is replaced by parse_ir's Qiskit-backed parser")

    def parse_ir(self, fname):
        circuit = QuantumCircuit.from_qasm_file(fname)
        self._record_registers(circuit)

        normalized = transpile(circuit, basis_gates=SUPPORTED_BASIS, optimization_level=0)
        for instruction in normalized.data:
            operation = instruction.operation
            if operation.name in {'barrier', 'measure'}:
                continue
            qbits = [normalized.find_bit(qubit).index for qubit in instruction.qubits]
            if len(qbits) == 1:
                self._add_single_qubit_gate(operation.name, qbits[0])
            elif len(qbits) == 2:
                self._add_two_qubit_gate(operation.name, qbits[0], qbits[1])
            else:
                sys.exit("Unsupported gate arity for " + operation.name + ": " + str(len(qbits)))

    def _record_registers(self, circuit):
        self.qbit_count = circuit.num_qubits
        self.qregs = {}
        self.cregs = {}
        for qreg in circuit.qregs:
            if len(qreg) == 0:
                continue
            base = circuit.find_bit(qreg[0]).index
            self.qregs[qreg.name] = (base, len(qreg))
        for creg in circuit.cregs:
            if len(creg) == 0:
                continue
            base = circuit.find_bit(creg[0]).index
            self.cregs[creg.name] = (base, len(creg))

    def _add_single_qubit_gate(self, gate_name, qbit):
        if not self.check_valid_qbit(qbit):
            sys.exit("qbit " + str(qbit) + " not in range")
        gate_id = self.global_gate_id
        self.gate_graph.add_node(gate_id)
        self.gate_qubit_map[gate_id] = [qbit]
        self.gate_name_map[gate_id] = gate_name
        for dgate in self.find_dep_gate(qbit):
            self._log("qbit " + str(qbit) + " dep gates: " + str(dgate))
            self.gate_graph.add_edge(dgate, gate_id)
        self.update_dep_gate(qbit, gate_id)
        self.global_gate_id += 1

    def _add_two_qubit_gate(self, gate_name, qbit1, qbit2):
        if not self.check_valid_qbit(qbit1):
            sys.exit("qbit " + str(qbit1) + " not in range")
        if not self.check_valid_qbit(qbit2):
            sys.exit("qbit " + str(qbit2) + " not in range")
        self.add_edge_pair(qbit1, qbit2)
        gate_id = self.global_gate_id
        self.gate_graph.add_node(gate_id)
        dep_gates = self.find_dep_gate(qbit1)
        dep_gates.extend(self.find_dep_gate(qbit2))
        self.update_dep_gate(qbit1, gate_id)
        self.update_dep_gate(qbit2, gate_id)
        self.cx_gate_map[gate_id] = [qbit1, qbit2]
        self.gate_qubit_map[gate_id] = [qbit1, qbit2]
        self.gate_name_map[gate_id] = gate_name
        self.two_qubit_gate_list.append(gate_id)
        for dgate in dep_gates:
            self._log("qbit 1: " + str(qbit1) + " qbit 2: " + str(qbit2) + " dep gates: " + str(dgate))
            self.gate_graph.add_edge(dgate, gate_id)
        self.global_gate_id += 1

    def _log(self, message):
        if self.verbose:
            print(message)

    def _gate_name(self, line):
        line = line.strip()
        if not line:
            return ''
        head = line.split(None, 1)[0]
        return head.split('(', 1)[0]

    def print_gates(self):
        for edge in self.gate_graph.edges:
            print(edge)

    def get_ir(self):
        return self.cx_gate_map, self.gate_graph

    def visualize_graph(self, fname):
        nx.write_gexf(self.cx_graph, fname)

    def check_valid_qbit(self, qbit):
        return qbit >= 0 and qbit < self.qbit_count
