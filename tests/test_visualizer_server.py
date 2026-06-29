import pytest

from visualizer_server import generate_trace, options_payload


def test_options_payload_exposes_programs_machines_capacities_and_mappers():
    payload = options_payload()

    assert "qft_n4" in {program["id"] for program in payload["programs"]}
    qaoa = next(program for program in payload["programs"] if program["id"] == "qaoa_n6")
    assert qaoa["category"] == "optimization"
    assert qaoa["qubits"] == 6
    assert qaoa["cx"] == 54
    assert "G3x3" in payload["machines"]
    assert 2 in payload["capacities"]
    assert "Greedy" in payload["mappers"]
    assert "SABRE" in payload["mappers"]
    assert "Naive" in payload["orderings"]
    assert "Fidelity" in payload["orderings"]
    assert "EJF-SerialComm" in payload["schedulers"]


def test_generate_trace_uses_selected_architecture_capacity_and_mapper():
    trace = generate_trace("qft_n4", "G3x3", 2, "Greedy")

    assert trace["validation"]["valid"] is True
    assert trace["run"]["machine"] == "G3x3"
    assert trace["run"]["ions_per_region"] == 2
    assert trace["run"]["mapper"] == "Greedy"
    assert len(trace["topology"]["traps"]) == 9


def test_generate_trace_uses_selected_mapper_ordering_and_scheduler_policy():
    trace = generate_trace("grover_n2", "G2x3", 1, "SABRE", "Fidelity", "EJF-SerialComm")

    assert trace["validation"]["valid"] is True
    assert trace["run"]["mapper"] == "SABRE"
    assert trace["run"]["reorder"] == "Fidelity"
    assert trace["run"]["scheduler_policy"] == "EJF-SerialComm"
    assert trace["run"]["serial_comm"] == 1
    assert trace["run"]["serial_trap_ops"] == 1
    assert trace["run"]["serial_all"] == 0


def test_scheduler_policy_changes_generated_timeline_when_policy_is_stricter():
    baseline = generate_trace("qft_n4", "G3x3", 2, "Greedy", "Naive", "EJF")
    global_serial = generate_trace("qft_n4", "G3x3", 2, "Greedy", "Naive", "EJF-GlobalSerial")

    assert global_serial["run"]["serial_all"] == 1
    assert global_serial["metrics"]["finish_time"] > baseline["metrics"]["finish_time"]


def test_initial_ordering_changes_greedy_initial_chain_layout():
    naive = generate_trace("qft_n4", "L6", 2, "Greedy", "Naive", "EJF")
    fidelity = generate_trace("qft_n4", "L6", 2, "Greedy", "Fidelity", "EJF")

    naive_layout = sorted((p["id"], p["initial_location"], p["initial_slot"]) for p in naive["particles"])
    fidelity_layout = sorted((p["id"], p["initial_location"], p["initial_slot"]) for p in fidelity["particles"])

    assert naive_layout != fidelity_layout


def test_generate_trace_rejects_infeasible_capacity_before_running_scheduler():
    with pytest.raises(ValueError, match="requires 10 logical qubits"):
        generate_trace("adder_n10", "L6", 1, "Greedy")
