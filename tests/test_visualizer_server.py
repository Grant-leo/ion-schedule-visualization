from visualizer_server import generate_trace, options_payload


def test_options_payload_exposes_programs_machines_capacities_and_mappers():
    payload = options_payload()

    assert "qft_n4" in {program["id"] for program in payload["programs"]}
    assert "G3x3" in payload["machines"]
    assert 2 in payload["capacities"]
    assert "Greedy" in payload["mappers"]


def test_generate_trace_uses_selected_architecture_capacity_and_mapper():
    trace = generate_trace("qft_n4", "G3x3", 2, "Greedy")

    assert trace["validation"]["valid"] is True
    assert trace["run"]["machine"] == "G3x3"
    assert trace["run"]["ions_per_region"] == 2
    assert trace["run"]["mapper"] == "Greedy"
    assert len(trace["topology"]["traps"]) == 9
