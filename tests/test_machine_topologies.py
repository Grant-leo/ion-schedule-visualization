from simulation import SimulationConfig, build_machine, supported_machine_names


def test_supported_machines_export_unique_topology_ids():
    for machine_name in supported_machine_names():
        machine = build_machine(SimulationConfig(program="unused.qasm", machine=machine_name, ions=2))

        trap_ids = [trap.id for trap in machine.traps]
        junction_ids = [junction.id for junction in machine.junctions]
        segment_ids = [segment.id for segment in machine.segments]

        assert len(trap_ids) == len(set(trap_ids)), machine_name
        assert len(junction_ids) == len(set(junction_ids)), machine_name
        assert len(segment_ids) == len(set(segment_ids)), machine_name


def test_g3x3_grid_architecture_uses_both_trap_chain_ports():
    machine = build_machine(SimulationConfig(program="unused.qasm", machine="G3x3", ions=2))

    port_sets = [set(trap.orientation.values()) for trap in machine.traps]

    assert {"L", "R"} <= set.union(*port_sets)
    assert any({"L", "R"} <= ports for ports in port_sets)
