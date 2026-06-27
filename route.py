import networkx as nx
from sorted_collection import SortedCollection
from operator import itemgetter
import numpy as np
from utils import *
from machine_state import MachineState
from machine import Trap, Segment, Junction

class BasicRoute:
    def __init__(self, machine):
        self.machine = machine

    def find_route(self, source_trap, dest_trap):
        graph = self.machine.graph
        tsrc = self.machine.traps[source_trap]
        tdest = self.machine.traps[dest_trap]
        path = nx.shortest_path(graph, source=tsrc, target=tdest)
        return path

class FreeTrapRoute:
    def __init__(self, machine, sys_state):
        self.machine = machine
        self.ss = sys_state

    def find_route(self, source_trap, dest_trap):
        #print("Check route:", source_trap, dest_trap)
        m = self.machine
        ss = self.ss
        edge_states = {}
        trap_free_space = {}
        for k in self.ss.trap_ions:
            trap_free_space[k] = m.traps[k].capacity - len(ss.trap_ions[k])
        for u, v in m.graph.edges:
            if type(u) == Trap and type(v) == Junction:
                e0 = u
                e1 = v
            elif type(u) == Junction and type(v) == Trap:
                e0 = v
                e1 = u
            elif type(u) == Junction and type(v) == Junction:
                #TODO: set zero weight
                edge_states[(u, v)] = 0
                edge_states[(v, u)] = 0
                continue

            if trap_free_space[e0.id] == 0 and e0.id != source_trap:
                edge_states[(e0, e1)] = 10**9
                edge_states[(e1, e0)] = 10**9
            else:
                edge_states[(e0, e1)] = 0
                edge_states[(e1, e0)] = 0

        nx.set_edge_attributes(m.graph, edge_states, 'block_status')
        ret = nx.shortest_path(m.graph, source=m.traps[source_trap], target=m.traps[dest_trap], weight='block_status')
        cost = 0
        for i in range(len(ret)-1):
            u = ret[i]
            v = ret[i+1]
            if (u,v) in edge_states:
                cost += edge_states[(u, v)]
            elif (v,u) in edge_states:
                cost += edge_states[(v, u)]
        if cost > 1:
            '''
            for item in edge_states:
                u = item[0]
                v = item[1]
                if type(u) == Trap and type(v) == Junction:
                    print("T"+str(u.id), "J"+str(v.id), edge_states[item])
                elif type(u) == Junction and type(v) == Trap:
                    print("T"+str(v.id), "J"+str(u.id), edge_states[item])
                elif type(u) == Junction and type(v) == Junction:
                    print("J"+str(u.id), "J"+str(v.id), edge_states[item])
                else:
                    print(item)
            print("")
            '''
            return 1, ret
        else:
            return 0, ret

class RouteAlgorithm:
    def __init__(self, machine):
        self.machine = machine
        self.setup_routing()

    def create_routing_graph(self):
        machine_obj = self.machine
        routing_graph = self.routing_graph
        for t in machine_obj.traps:
            routing_graph.add_node(trap_name(t.id))
        for s in machine_obj.segments:
            routing_graph.add_node(seg_name(s.id))
        junction_segments = {}
        for u, v, data in machine_obj.graph.edges(data=True):
            segment = data['seg']
            segment_node = seg_name(segment.id)
            for endpoint in (u, v):
                if isinstance(endpoint, Trap):
                    routing_graph.add_edge(trap_name(endpoint.id), segment_node)
                elif isinstance(endpoint, Junction):
                    junction_segments.setdefault(endpoint.id, []).append(segment.id)
        for segment_ids in junction_segments.values():
            for i, first in enumerate(segment_ids):
                for second in segment_ids[i + 1:]:
                    routing_graph.add_edge(seg_name(first), seg_name(second))

    def add_routing_graph_weights(self):
        machine_obj = self.machine
        routing_graph = self.routing_graph
        segments_by_id = {segment.id: segment for segment in machine_obj.segments}
        for u, v in routing_graph.edges:
            if u.startswith("T") and v.startswith("S"):
                my_weight = segments_by_id[seg_id(v)].length / 2
            elif u.startswith("S") and v.startswith("T"):
                my_weight = segments_by_id[seg_id(u)].length / 2
            else:
                my_weight = (segments_by_id[seg_id(u)].length + segments_by_id[seg_id(v)].length) / 2
            routing_graph[u][v]['weight'] = my_weight

    def setup_routing(self):
        #if self.machine_state.check_ion_in_a_trap(self.ion1) == 0 or self.machine_state.check_ion_in_a_trap(self.ion2) == 0:
        #    return -1
        self.routing_graph = nx.Graph()
        self.create_routing_graph()
        self.add_routing_graph_weights()
        #source_trap = self.machine_state.find_trap_id_by_ion(self.ion1)
        #dest_trap = self.machine_state.find_trap_id_by_ion(self.ion2)

    def find_route(self, source_trap, dest_trap):
        path = nx.shortest_path(self.routing_graph, source=trap_name(source_trap), target=trap_name(dest_trap), weight='weight')
        return path
