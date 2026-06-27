from dataclasses import dataclass

import numpy as np

from ejf_schedule import EJFSchedule
from machine import MachineParams
from mappers import QubitMapAgg, QubitMapGreedy, QubitMapLPFS, QubitMapPO, QubitMapRandom, QubitOrdering
from parse import InputParse
from test_machines import (
    make_3x3_grid,
    make_9trap,
    make_linear_machine,
    make_single_hexagon_machine,
    mktrap4x2,
    mktrap6x3,
    mktrap8x4,
    test_trap_2x3,
)


@dataclass(frozen=True)
class SimulationConfig:
    program: str
    machine: str = "L6"
    ions: int = 2
    mapper: str = "Greedy"
    reorder: str = "Naive"
    serial_trap_ops: int = 1
    serial_comm: int = 0
    serial_all: int = 0
    gate_type: str = "FM"
    swap_type: str = "GateSwap"
    single_qubit_gate_time: int = 7
    single_qubit_gate_fidelity: float = 0.999


@dataclass
class SimulationResult:
    config: SimulationConfig
    parser: InputParse
    machine: object
    initial_layout: dict
    scheduler: EJFSchedule


def make_machine_params(config):
    params = MachineParams()
    params.gate_type = config.gate_type
    params.swap_type = config.swap_type
    params.single_qubit_gate_time = config.single_qubit_gate_time
    params.single_qubit_gate_fidelity = config.single_qubit_gate_fidelity
    return params


def supported_machine_names():
    return tuple(MACHINE_BUILDERS.keys())


def _linear6(capacity, params):
    return make_linear_machine(6, capacity, params)


MACHINE_BUILDERS = {
    "L6": _linear6,
    "H6": make_single_hexagon_machine,
    "G2x3": test_trap_2x3,
    "T4x2": mktrap4x2,
    "T6x3": mktrap6x3,
    "T8x4": mktrap8x4,
    "G3x3": make_3x3_grid,
    "G9": make_9trap,
}


def build_machine(config):
    params = make_machine_params(config)
    try:
        builder = MACHINE_BUILDERS[config.machine]
    except KeyError as exc:
        raise ValueError("Unsupported machine type: " + config.machine) from exc
    return builder(config.ions, params)


def build_mapper(config, parser, machine):
    if config.mapper == "LPFS":
        return QubitMapLPFS(parser, machine)
    if config.mapper == "Agg":
        return QubitMapAgg(parser, machine)
    if config.mapper == "Random":
        return QubitMapRandom(parser, machine)
    if config.mapper == "PO":
        return QubitMapPO(parser, machine)
    if config.mapper == "Greedy":
        return QubitMapGreedy(parser, machine)
    raise ValueError("Unsupported mapper: " + config.mapper)


def build_initial_layout(config, parser, machine):
    mapping = build_mapper(config, parser, machine).compute_mapping()
    if config.mapper == "Greedy":
        return mapping
    ordering = QubitOrdering(parser, machine, mapping)
    if config.reorder == "Naive":
        return ordering.reorder_naive()
    if config.reorder == "Fidelity":
        return ordering.reorder_fidelity()
    raise ValueError("Unsupported reorder policy: " + config.reorder)


def run_simulation(config):
    np.random.seed(12345)
    parser = InputParse()
    parser.parse_ir(config.program)
    machine = build_machine(config)
    initial_layout = build_initial_layout(config, parser, machine)
    scheduler = EJFSchedule(
        parser.gate_graph,
        parser.cx_gate_map,
        machine,
        initial_layout,
        config.serial_trap_ops,
        config.serial_comm,
        config.serial_all,
        gate_qubit_map=parser.gate_qubit_map,
        gate_name_map=parser.gate_name_map,
    )
    scheduler.run()
    return SimulationResult(config, parser, machine, initial_layout, scheduler)
