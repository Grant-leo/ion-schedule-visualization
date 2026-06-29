'''
Generates an initial qubit mapping
Three mappers:
    QubitMapPO - Program Order based
    QubitMapMetis - Metis clustering
    QubitMapAgg - Agglomerative cluster

Metis mapping didnt work very well, use either PO or Agg mappers

Output of this step is a partitioning of the qubits into regions given by a dictionary
prog_qubit -> region id

TODO mrm suggested comparing to lpfs. Need to check if its feasible to implement the comparison
'''

import sys
import networkx as nx
import numpy as np
from sklearn.cluster import AgglomerativeClustering as AggClus
import copy
from route import BasicRoute

try:
    import metis as mt
except ImportError:
    mt = None


def _program_qubit_count(parse_obj):
    return getattr(parse_obj, 'qbit_count', 0) or len(list(parse_obj.cx_graph.nodes))


def _trap_sizes(machine_obj, excess_capacity=0):
    return [max(0, trap.capacity - excess_capacity) for trap in machine_obj.traps]


def _ensure_capacity(num_qubits, trap_sizes):
    if sum(trap_sizes) < num_qubits:
        raise ValueError("Machine capacity is smaller than the number of program qubits")


def _sequential_qubit_mapping(num_qubits, trap_sizes):
    _ensure_capacity(num_qubits, trap_sizes)
    partition = []
    for trap_id, size in enumerate(trap_sizes):
        partition.extend([trap_id] * size)
    return {qubit: partition[qubit] for qubit in range(num_qubits)}


def _fill_unmapped_qubit_mapping(mapping, num_qubits, trap_sizes):
    _ensure_capacity(num_qubits, trap_sizes)
    used = {trap_id: 0 for trap_id in range(len(trap_sizes))}
    for trap_id in mapping.values():
        used[trap_id] += 1
    for qubit in range(num_qubits):
        if qubit in mapping:
            continue
        for trap_id, size in enumerate(trap_sizes):
            if used[trap_id] < size:
                mapping[qubit] = trap_id
                used[trap_id] += 1
                break
        else:
            raise ValueError("Machine capacity is smaller than the number of program qubits")
    return mapping


def _make_agglomerative(n_clusters):
    try:
        return AggClus(n_clusters=n_clusters, metric='precomputed', linkage='average')
    except TypeError:
        return AggClus(n_clusters=n_clusters, affinity='precomputed', linkage='average')


class QubitMapGreedy:
    def __init__(self, parse_obj, machine_obj):
        self.parse_obj = parse_obj
        self.machine_obj = machine_obj
        self.build_program_graph()
        self.pending_program_edges = []
        self.mapping = []
        self.remaining_capacity = []
        trap_capacity = self.machine_obj.traps[0].capacity
        for i in range(len(machine_obj.traps)):
            self.mapping.append([])
            self.remaining_capacity.append(trap_capacity)
        self.router = BasicRoute(machine_obj)

    def gate_tuple(self, g):
        return (min(g), max(g))

    def build_program_graph(self):
        self.prog_graph = nx.Graph()
        edge_weights = {}
        # add support for single qubit (not cx gates)
        # check gate id or get node label in networkx
        # if single qubit, skip over this whole part
        # try printing out parse_obj - the gate ids are there
        # when you get an id, check if it exists in the cx_gate_map
        # if it does, then it is a 2 qubit gate
        # if not, then continue
        for g in self.parse_obj.gate_graph:
            if g not in self.parse_obj.cx_gate_map:
                continue
            g_qubits = self.parse_obj.cx_gate_map[g]
            tup = self.gate_tuple(g_qubits)
            if tup in edge_weights:
                edge_weights[tup] += 1
            else:
                edge_weights[tup] = 1
        #print(edge_weights)
        for key in edge_weights:
            self.prog_graph.add_edge(*key, weight=edge_weights[key])
        #print(prog_graph.edges)

    def _is_mapped(self, qubit):
        for item in self.mapping:
            if qubit in item:
                return True
        return False

    def _trap(self, qubit):
        for i, item in enumerate(self.mapping):
            if qubit in item:
                return i
        assert 0

    def _first_available_trap(self):
        for trap_id, capacity in enumerate(self.remaining_capacity):
            if capacity > 0:
                return trap_id
        raise ValueError("Machine capacity is smaller than the number of program qubits")

    def _map_remaining_qubits(self):
        for qubit in range(_program_qubit_count(self.parse_obj)):
            if self._is_mapped(qubit):
                continue
            trap_id = self._first_available_trap()
            self.mapping[trap_id].append(qubit)
            self.remaining_capacity[trap_id] -= 1

    def _select_next_edge(self):
        """Select the next edge.
        If there is an edge with one endpoint mapped, return it.
        Else return in the first edge
        """
        for edge in self.pending_program_edges:
            q1_mapped = self._is_mapped(edge[0])
            q2_mapped = self._is_mapped(edge[1])
            assert not (q1_mapped and q2_mapped)
            if q1_mapped or q2_mapped:
                return edge
        return self.pending_program_edges[0]

    def _map_qubit(self, qubit):
        #Iterate through traps and pick the best one
        all_dist = []
        for target_trap in range(len(self.machine_obj.traps)):
            if self.remaining_capacity[target_trap] == 0:
                all_dist.append(float('inf'))
            else:
                sum_distances = 0
                for n in self.prog_graph.neighbors(qubit):
                    if self._is_mapped(n):
                        src_trap = self._trap(n)
                        path = self.router.find_route(src_trap, target_trap)
                        sum_distances += len(path)
                all_dist.append(sum_distances)
        if all_dist:
            return all_dist.index(min(all_dist))
        else:
            for i, val in enumerate(self.remaining_capacity):
                if val > 0:
                    return i
        assert 0

    def compute_mapping(self):
        for end1, end2, _ in sorted(self.prog_graph.edges(data=True),
                                    key=lambda x: x[2]['weight'], reverse=True):
            self.pending_program_edges.append((end1, end2))
        while self.pending_program_edges:
            edge = self._select_next_edge()
            q1_mapped = self._is_mapped(edge[0])
            q2_mapped = self._is_mapped(edge[1])
            if not q1_mapped:
                q1_trap = self._map_qubit(edge[0])
                self.mapping[q1_trap].append(edge[0])
                self.remaining_capacity[q1_trap] -= 1
            if not q2_mapped:
                q2_trap = self._map_qubit(edge[1])
                self.mapping[q2_trap].append(edge[1])
                self.remaining_capacity[q2_trap] -= 1
            tmplist = [x for x in self.pending_program_edges if not (self._is_mapped(x[0]) and self._is_mapped(x[1]))]
            self.pending_program_edges = tmplist
        self._map_remaining_qubits()
        output_partition = {}
        for i in range(len(self.mapping)):
            output_partition[i] = self.mapping[i]
        return output_partition

class QubitMapLPFS:
    def __init__(self, parse_obj, machine_obj, excess_capacity=0):
        self.parse_obj = parse_obj
        self.machine_obj = machine_obj
        self.excess_capacity = excess_capacity

    def compute_mapping(self):
        gate_graph = copy.deepcopy(self.parse_obj.gate_graph)
        k = len(self.machine_obj.traps)
        cap = self.machine_obj.traps[0].capacity
        already_mapped = []
        mapping = []
        for i in range(k):
            path = nx.algorithms.dag.dag_longest_path(gate_graph)
            qubit_set = []
            used_gates = []
            for g in path:
                if g not in self.parse_obj.cx_gate_map:
                    used_gates.append(g)
                    continue
                if len(qubit_set) >= cap-1:
                    break
                g_qubits = self.parse_obj.cx_gate_map[g]
                if g == 992:
                    print(g_qubits)
                for qubit in g_qubits:
                    if qubit in already_mapped:
                        continue
                    qubit_set.append(qubit)
                    already_mapped.append(qubit)
                    if not g in used_gates:
                        used_gates.append(g)
            mapping.append(qubit_set)
            for g in used_gates:
                gate_graph.remove_node(g)
        output_partition = {}
        for i, qubit_set in enumerate(mapping):
            for q in qubit_set:
                output_partition[q] = i
        num_qubits = _program_qubit_count(self.parse_obj)
        return _fill_unmapped_qubit_mapping(output_partition, num_qubits, _trap_sizes(self.machine_obj, self.excess_capacity))

class QubitMapRandom:
    def __init__(self, parse_obj, machine_obj, excess_capacity=0):
        self.parse_obj = parse_obj
        self.machine_obj = machine_obj
        self.excess_capacity = excess_capacity

    def compute_mapping(self):
        num_qubits = _program_qubit_count(self.parse_obj)
        partition = []
        trap_sizes = _trap_sizes(self.machine_obj, self.excess_capacity)
        _ensure_capacity(num_qubits, trap_sizes)
        for i in range(len(trap_sizes)):
            partition.extend([i]*trap_sizes[i])
        partition = partition[:num_qubits]
        np.random.shuffle(partition)
        output_partition = {}
        for i in range(len(partition)):
            output_partition[i] = partition[i]
        return output_partition

class QubitMapPO:
    def __init__(self, parse_obj, machine_obj, excess_capacity=0):
        self.parse_obj = parse_obj
        self.machine_obj = machine_obj
        self.excess_capacity = excess_capacity

    def compute_mapping(self):
        num_qubits = _program_qubit_count(self.parse_obj)
        return _sequential_qubit_mapping(num_qubits, _trap_sizes(self.machine_obj, self.excess_capacity))


class QubitMapSABRE:
    """A deterministic SABRE-style initial placement heuristic.

    Qiskit's SABRE is a dynamic layout/routing pass for circuit coupling maps.
    QCCDSim maps qubits to ion traps instead, so this mapper keeps the same
    core idea: place front-layer and high-interaction qubits close on the
    hardware graph, with a small occupancy decay term to avoid overfilling.
    """

    def __init__(self, parse_obj, machine_obj, excess_capacity=0):
        self.parse_obj = parse_obj
        self.machine_obj = machine_obj
        self.excess_capacity = excess_capacity
        self.router = BasicRoute(machine_obj)

    def compute_mapping(self):
        num_qubits = _program_qubit_count(self.parse_obj)
        trap_sizes = _trap_sizes(self.machine_obj, self.excess_capacity)
        _ensure_capacity(num_qubits, trap_sizes)
        if num_qubits == 0:
            return {}

        weights = self._interaction_weights(num_qubits)
        order = self._placement_order(num_qubits, weights)
        distances = self._trap_distances()
        used = {trap_id: 0 for trap_id in range(len(trap_sizes))}
        mapping = {}

        for qubit in order:
            candidate = self._best_trap_for_qubit(qubit, mapping, used, trap_sizes, weights, distances)
            mapping[qubit] = candidate
            used[candidate] += 1

        return _fill_unmapped_qubit_mapping(mapping, num_qubits, trap_sizes)

    def _interaction_weights(self, num_qubits):
        weights = {qubit: {} for qubit in range(num_qubits)}
        for left, right, data in self.parse_obj.cx_graph.edges(data=True):
            weight = data.get('weight', 1)
            weights.setdefault(left, {})[right] = weights.setdefault(left, {}).get(right, 0) + weight
            weights.setdefault(right, {})[left] = weights.setdefault(right, {}).get(left, 0) + weight
        return weights

    def _placement_order(self, num_qubits, weights):
        front_score = {qubit: 0 for qubit in range(num_qubits)}
        for index, gate in enumerate(nx.topological_sort(self.parse_obj.gate_graph)):
            gate_qubits = self.parse_obj.gate_qubit_map.get(gate, [])
            for qubit in gate_qubits:
                front_score[qubit] += max(1, num_qubits * 4 - index)

        return sorted(
            range(num_qubits),
            key=lambda qubit: (
                -sum(weights.get(qubit, {}).values()),
                -front_score.get(qubit, 0),
                qubit,
            ),
        )

    def _trap_distances(self):
        distances = {}
        for src in range(len(self.machine_obj.traps)):
            for dest in range(len(self.machine_obj.traps)):
                if src == dest:
                    distances[(src, dest)] = 0
                    continue
                route = self.router.find_route(src, dest)
                distances[(src, dest)] = max(1, len(route) - 1)
        return distances

    def _best_trap_for_qubit(self, qubit, mapping, used, trap_sizes, weights, distances):
        best = None
        best_score = float('inf')
        average_distance = self._average_trap_distance(distances, len(trap_sizes))
        for trap_id, capacity in enumerate(trap_sizes):
            if used[trap_id] >= capacity:
                continue
            score = 0
            mapped_neighbors = 0
            for neighbor, weight in weights.get(qubit, {}).items():
                if neighbor not in mapping:
                    continue
                mapped_neighbors += 1
                score += weight * distances[(trap_id, mapping[neighbor])]
            if mapped_neighbors == 0:
                score += average_distance[trap_id]
            score += used[trap_id] * 0.01
            if score < best_score:
                best = trap_id
                best_score = score
        if best is None:
            raise ValueError("Machine capacity is smaller than the number of program qubits")
        return best

    def _average_trap_distance(self, distances, trap_count):
        average = {}
        for trap_id in range(trap_count):
            total = sum(distances[(trap_id, other)] for other in range(trap_count))
            average[trap_id] = total / max(1, trap_count)
        return average

class QubitMapMetis:
    def __init__(self, parse_obj, machine_obj):
        self.parse_obj = parse_obj
        self.machine_obj = machine_obj

    def partition_graph(self, parts, cx_graph):
        if mt is None:
            raise ImportError("Metis mapper requires pymetis or metis to be installed")
        tpwgts = []
        ubvec = [1.1]
        for i in range(parts):
            tpwgts.append((1.0/parts))
        out = mt.part_graph(cx_graph, nparts=parts, tpwgts=tpwgts, ubvec=ubvec)
        return out

    def compute_mapping(self):
        num_parts = len(self.machine_obj.traps)
        parts = self.partition_graph(num_parts, self.parse_obj.cx_graph)
        #TODO: can we partition with lesser parts?
        #TODO: initial mapping may exceed bounds
        #TODO: init mapping not aware of cluster distances
        #TODO: adjust mapping partition: full set of clusters with tail cluster
        tot_wt = 0
        for c in self.parse_obj.edge_weights.keys():
            for t in self.parse_obj.edge_weights[c].keys():
                tot_wt += self.parse_obj.edge_weights[c][t]
        output_partition = {}
        for i in range(len(parts[1])):
            output_partition[i] = parts[1][i]
        return output_partition

class QubitMapAgg():
    def __init__(self, parse_obj, machine_obj):
        self.parse_obj = parse_obj
        self.machine_obj = machine_obj
        self.num_traps = len(self.machine_obj.traps)
        self.num_nodes = _program_qubit_count(self.parse_obj)
        self.trap_capacity = self.machine_obj.traps[0].capacity
        self.occupied_traps = 0
        self.qubit_mapping = {}
        self.trap_empty_space = {}
        for i in range(self.num_traps):
            self.trap_empty_space[i] = self.trap_capacity
    #
    def select_from_clusters(self, u, nclusters):
        curr_clusters = []
        for i in range(nclusters):
            curr_clusters.append([])

        for i in range(len(u)):
            curr_clusters[u[i]].append(i)
        bad_cluster = False
        for clus in curr_clusters:
            if len(clus) > self.trap_capacity:
                bad_cluster = True
        if bad_cluster:
            return 0

        curr_clusters.sort(key=len, reverse=True)
        candidate_mapping = {}
        candidate_space = {}
        for i in range(self.num_traps):
            candidate_space[i] = self.trap_capacity
        top_k = min(3, self.num_traps)
        top_k = min(top_k, nclusters)
        for i in range(top_k):
            clus = curr_clusters[i]
            #print("Map", clus, "trap", i)
            for pq in clus:
                candidate_mapping[pq] = i
            candidate_space[i] -= len(clus)

        #print("unmapped")
        #print("caps:", self.trap_empty_space)
        for clus in curr_clusters[top_k:]:
            #if clus fits fully in some trap, assign it there
            is_assigned = False
            for i in range(self.num_traps):
                if candidate_space[i] >= len(clus):
                    #print("Map", clus, "trap", i)
                    for pq in clus:
                        candidate_mapping[pq] = i
                    candidate_space[i] -= len(clus)
                    is_assigned = True
                    break
            if not is_assigned:
                remaining = list(clus)
                for i in range(self.num_traps):
                    available_capacity = candidate_space[i]
                    if available_capacity == 0:
                        continue
                    #print("Map", clus, "trap", i)
                    take = min(available_capacity, len(remaining))
                    for pq in remaining[:take]:
                        candidate_mapping[pq] = i
                    candidate_space[i] -= take
                    remaining = remaining[take:]
                    if not remaining:
                        break
                if remaining:
                    return 0

        self.qubit_mapping = candidate_mapping
        self.trap_empty_space = candidate_space
        return 1

    def compute_mapping(self):
        #compute affinity matrix of distances
        #distance function 1 - f/T
        if self.num_nodes == 0:
            return {}
        trap_sizes = _trap_sizes(self.machine_obj)
        _ensure_capacity(self.num_nodes, trap_sizes)
        if self.parse_obj.cx_graph.number_of_edges() == 0:
            return _sequential_qubit_mapping(self.num_nodes, trap_sizes)
        affinity_matrix = np.ones([self.num_nodes, self.num_nodes])
        T = 0
        for u, v, d in self.parse_obj.cx_graph.edges(data=True):
            T = max(T, d['weight'])
        if T == 0:
            return _sequential_qubit_mapping(self.num_nodes, trap_sizes)
        for u, v, d in self.parse_obj.cx_graph.edges(data=True):
            f = d['weight']
            factor = float(f)/T
            affinity_matrix[u][v] = 1.0 - (factor)
            affinity_matrix[v][u] = 1.0 - (factor)
        for i in range(1, self.num_nodes + 1):
            agg = _make_agglomerative(i)
            u = agg.fit_predict(affinity_matrix)
            #print("Clustering level", i)
            done = self.select_from_clusters(u, i)
            if done == 1:
                break
        if len(self.qubit_mapping) != self.num_nodes:
            self.qubit_mapping = _sequential_qubit_mapping(self.num_nodes, trap_sizes)
        return self.qubit_mapping

'''
Reorders qubits within a region according to fidelity
Simple heuristic for now: places qubits with lot of gates
around the the center of the chain
'''
class QubitOrdering():
    def __init__(self, parse_obj, machine_obj, qubit_mapping):
        self.parse_obj = parse_obj
        self.machine_obj = machine_obj
        self.mapping = qubit_mapping
        self.trap_capacity = self.machine_obj.traps[0].capacity
        self.num_traps = len(self.machine_obj.traps)

    def reorder_naive(self):
        output_layout = {}
        for i in range(self.num_traps):
            this_layout = []
            for q in self.mapping.keys():
                if self.mapping[q] == i: # q belongs to trap i
                    this_layout.append(q)
            output_layout[i] = this_layout
        return output_layout

    def reorder_fidelity(self):
        output_layout = {}
        for i in range(self.num_traps):
            this_layout = []
            candidates = []
            for q in self.mapping.keys():
                if self.mapping[q] == i: # q belongs to trap i
                    candidates.append(q)

            candidates_with_wt = []
            for c in candidates:
                wt = 0
                for u, v, d in self.parse_obj.cx_graph.edges(data=True):
                    if u == c or v == c:
                        wt += d['weight']
                candidates_with_wt.append((c, wt))
            #Find weight of each qubit as the no. of gates using the qubits
            #Sort qubits according to descending order of weight
            candidates_with_wt.sort(key=lambda tup: tup[1], reverse=True)
            coin = 0
            #Places qubits in an odd-even fashion around the center of the chain
            for item in candidates_with_wt:
                if coin == 0:
                    this_layout.append(item[0])
                    coin = 1
                elif coin == 1:
                    this_layout.insert(0, item[0])
                    coin = 0
            output_layout[i] = this_layout
        return output_layout
