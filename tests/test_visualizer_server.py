import pytest

from visualizer_server import generate_trace, options_payload


def test_options_payload_exposes_programs_machines_capacities_and_mappers():
    payload = options_payload()

    assert "qft_n4" in {program["id"] for program in payload["programs"]}
    assert payload["defaults"] == {
        "program": "swap_test_n25",
        "machine": "G3x3",
        "capacity": 3,
        "mapper": "SABRE",
        "ordering": "Naive",
        "scheduler": "EJF",
    }
    qaoa = next(program for program in payload["programs"] if program["id"] == "qaoa_n6")
    assert qaoa["category"] == "optimization"
    assert qaoa["qubits"] == 6
    assert qaoa["cx"] == 54
    assert "G3x3" in payload["machines"]
    assert payload["machine_trap_counts"]["G3x3"] == 9
    assert payload["machine_trap_counts"]["L6"] == 6
    assert 2 in payload["capacities"]
    assert "Greedy" in payload["mappers"]
    assert "SABRE" in payload["mappers"]
    assert "Naive" in payload["orderings"]
    assert "Fidelity" in payload["orderings"]
    assert "EJF-SerialComm" in payload["schedulers"]
    assert "EJF-ParallelTrap" not in payload["schedulers"]
    assert all(option["id"] != "EJF-ParallelTrap" for option in payload["scheduler_options"])
    labels = {option["id"]: option["label"] for option in payload["scheduler_options"]}
    assert labels["EJF"] == "Parallel schedule"
    assert labels["EJF-GlobalSerial"] == "Serial schedule"


def test_generate_trace_uses_selected_architecture_capacity_and_mapper():
    trace = generate_trace("qft_n4", "G3x3", 2, "Greedy")

    assert trace["validation"]["valid"] is True
    assert trace["run"]["machine"] == "G3x3"
    assert trace["run"]["ions_per_region"] == 2
    assert trace["run"]["mapper"] == "Greedy"
    assert len(trace["topology"]["traps"]) == 9
    assert {"max_parallel_gates", "cross_trap_parallel_gates", "same_trap_gate_overlaps"} <= trace["metrics"].keys()


def test_generate_trace_uses_selected_mapper_ordering_and_scheduler_policy():
    trace = generate_trace("grover_n2", "G2x3", 1, "SABRE", "Fidelity", "EJF-SerialComm")

    assert trace["validation"]["valid"] is True
    assert trace["run"]["mapper"] == "SABRE"
    assert trace["run"]["reorder"] == "Fidelity"
    assert trace["run"]["scheduler_policy"] == "EJF-SerialComm"
    assert trace["run"]["serial_comm"] == 1
    assert trace["run"]["serial_trap_ops"] == 1
    assert trace["run"]["serial_all"] == 0


def test_visualizer_rejects_nonphysical_parallel_trap_scheduler_policy():
    with pytest.raises(ValueError, match="Unsupported visualizer scheduler"):
        generate_trace("qft_n4", "G3x3", 2, "Greedy", "Naive", "EJF-ParallelTrap")


def test_scheduler_policy_changes_generated_timeline_when_policy_is_stricter():
    baseline = generate_trace("qft_n4", "G3x3", 2, "Greedy", "Naive", "EJF")
    global_serial = generate_trace("qft_n4", "G3x3", 2, "Greedy", "Naive", "EJF-GlobalSerial")

    assert global_serial["run"]["serial_all"] == 1
    assert global_serial["metrics"]["finish_time"] > baseline["metrics"]["finish_time"]


def test_ejf_serializes_same_trap_gates_but_allows_cross_trap_parallel_gates():
    trace = generate_trace("swap_test_n25", "G3x3", 3, "SABRE", "Naive", "EJF")

    assert trace["validation"]["valid"] is True
    assert trace["run"]["serial_trap_ops"] == 1
    assert trace["run"]["serial_all"] == 0
    assert trace["metrics"]["max_parallel_gates"] > 1
    assert trace["metrics"]["cross_trap_parallel_gates"] > 0
    assert trace["metrics"]["same_trap_gate_overlaps"] == 0
    assert _same_trap_gate_overlaps(trace["events"]) == 0
    assert _cross_trap_gate_parallel_samples(trace["events"]) > 0


def test_initial_ordering_changes_greedy_initial_chain_layout():
    naive = generate_trace("qft_n4", "L6", 2, "Greedy", "Naive", "EJF")
    fidelity = generate_trace("qft_n4", "L6", 2, "Greedy", "Fidelity", "EJF")

    naive_layout = sorted((p["id"], p["initial_location"], p["initial_slot"]) for p in naive["particles"])
    fidelity_layout = sorted((p["id"], p["initial_location"], p["initial_slot"]) for p in fidelity["particles"])

    assert naive_layout != fidelity_layout


def test_mapper_selection_changes_initial_chain_layout_for_same_experiment():
    layouts = {}
    for mapper in ["PO", "Greedy", "SABRE"]:
        trace = generate_trace("adder_n10", "L6", 3, mapper, "Naive", "EJF")
        layouts[mapper] = sorted((p["id"], p["initial_location"], p["initial_slot"]) for p in trace["particles"])

    assert layouts["PO"] != layouts["Greedy"]
    assert layouts["PO"] != layouts["SABRE"]
    assert layouts["Greedy"] != layouts["SABRE"]


def test_generate_trace_rejects_infeasible_capacity_before_running_scheduler():
    with pytest.raises(ValueError, match="requires 10 logical qubits"):
        generate_trace("adder_n10", "L6", 1, "Greedy")


def _same_trap_gate_overlaps(events):
    gates = [event for event in events if event["type"] == "gate"]
    overlaps = 0
    for index, left in enumerate(gates):
        for right in gates[index + 1 :]:
            if left["target"] != right["target"]:
                continue
            if left["start"] < right["end"] and right["start"] < left["end"]:
                overlaps += 1
    return overlaps


def _cross_trap_gate_parallel_samples(events):
    gates = [event for event in events if event["type"] == "gate"]
    samples = 0
    for index, left in enumerate(gates):
        for right in gates[index + 1 :]:
            if left["target"] == right["target"]:
                continue
            if left["start"] < right["end"] and right["start"] < left["end"]:
                samples += 1
    return samples
