import json
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

from visualizer_server import VisualizerHandler
from visualizer_server import CAPACITIES
from visualizer_server import MAX_IMPORT_BYTES
from visualizer_server import PROGRAMS
from visualizer_server import STATIC_DIR
from visualizer_server import _machine_trap_count


FIXTURE_DIR = STATIC_DIR.parent / "tests" / "fixtures" / "trace_contract"
ARCHITECTURE_FIXTURE_DIR = STATIC_DIR.parent / "tests" / "fixtures" / "architectures"


class QuietVisualizerHandler(VisualizerHandler):
    def log_message(self, format, *args):
        pass


@pytest.fixture()
def visualizer_http_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), QuietVisualizerHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def read_json(url):
    with urllib.request.urlopen(url, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def post_json(url, payload, content_type="application/json"):
    body = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST", headers={"Content-Type": content_type})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def load_external_fixture(name):
    return json.loads((FIXTURE_DIR / name).read_text(encoding="utf-8"))


def load_architecture_fixture(name):
    return json.loads((ARCHITECTURE_FIXTURE_DIR / name).read_text(encoding="utf-8"))


def test_visualizer_options_endpoint_serves_demo_defaults(visualizer_http_server):
    payload = read_json(f"{visualizer_http_server}/api/options")

    assert payload["defaults"] == {
        "program": "swap_test_n25",
        "machine": "G3x3",
        "capacity": 3,
        "mapper": "SABRE",
        "ordering": "Naive",
        "scheduler": "EJF",
    }
    assert any(program["id"] == "qft_n4" for program in payload["programs"])
    assert any(program["id"] == "swap_test_n25" for program in payload["programs"])
    assert "G3x3" in payload["machines"]
    assert payload["machine_trap_counts"]["G3x3"] == 9
    assert "SABRE" in payload["mappers"]
    assert "EJF-GlobalSerial" in payload["schedulers"]
    assert "EJF-ParallelTrap" not in payload["schedulers"]


def test_visualizer_html_uses_cache_busted_core_assets():
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")

    assert './styles.css?v=' in html
    assert './app.js?v=' in html
    assert 'id="orderingSelect"' in html
    assert 'id="schedulerSelect"' in html
    assert 'id="parallelSchedulerButton"' in html
    assert 'id="serialSchedulerButton"' in html
    assert 'id="headlineMetricsPanel"' in html
    assert 'scope-pill' not in html
    assert 'status-pill' not in html
    assert 'id="timeReadout">0 / 0 gates' in html
    assert 'id="benchmarkMetaPanel"' in html
    assert 'id="runConfigPanel"' in html
    assert 'id="configErrorPanel"' in html
    assert 'id="circuitPanel"' in html
    assert 'data-source-mode="experiment"' in html
    assert 'data-source-mode="trace"' in html
    assert 'id="vizSummary"' in html


def test_visualizer_medium_viewport_uses_uncramped_layout_breakpoint():
    css = (STATIC_DIR / "styles.css").read_text(encoding="utf-8")

    assert "@media (max-width: 1240px)" in css
    assert "@media (max-width: 1360px)" not in css
    assert "grid-template-areas:\n      \"header header\"\n      \"left viewport\"\n      \"right right\"" in css


def test_visualizer_desktop_dag_inspector_keeps_dag_large_without_hiding_timeline_focus():
    css = (STATIC_DIR / "styles.css").read_text(encoding="utf-8")

    assert "grid-template-areas:\n    \"header header right\"\n    \"left viewport right\"\n    \"timeline timeline right\"" in css
    assert "grid-template-rows: minmax(0, 1fr);" in css
    assert "overflow: hidden;\n  display: grid;" in css
    assert "height: 100%;" in css
    assert "grid-template-rows: 78px minmax(0, 1fr) 48px;" in css
    assert "grid-template-rows: 96px minmax(0, 1fr);" in css
    assert "grid-template-areas:\n      \"header\"\n      \"viewport\"\n      \"timeline\"\n      \"left\"\n      \"right\";" in css


def test_visualizer_static_assets_are_not_cached_between_demo_iterations(visualizer_http_server):
    with urllib.request.urlopen(f"{visualizer_http_server}/canvas_renderer.js", timeout=30) as response:
        assert response.headers["Cache-Control"] == "no-store"


def test_visualizer_trace_endpoint_serves_valid_qccdsim_trace(visualizer_http_server):
    query = urllib.parse.urlencode(
        {
            "program": "qft_n4",
            "machine": "G3x3",
            "capacity": "2",
            "mapper": "Greedy",
            "ordering": "Naive",
            "scheduler": "EJF",
        }
    )
    trace = read_json(f"{visualizer_http_server}/api/trace?{query}")

    assert trace["device_type"] == "ion_trap"
    assert trace["run"]["machine"] == "G3x3"
    assert trace["validation"]["valid"] is True
    assert trace["metrics"]["event_count"] == len(trace["events"])
    assert trace["metrics"]["shuttling_time"] > 0


def test_visualizer_trace_endpoint_applies_mapper_ordering_and_scheduler(visualizer_http_server):
    query = urllib.parse.urlencode(
        {
            "program": "qft_n4",
            "machine": "G3x3",
            "capacity": "2",
            "mapper": "SABRE",
            "ordering": "Naive",
            "scheduler": "EJF-GlobalSerial",
        }
    )

    trace = read_json(f"{visualizer_http_server}/api/trace?{query}")

    assert trace["run"]["mapper"] == "SABRE"
    assert trace["run"]["reorder"] == "Naive"
    assert trace["run"]["scheduler_policy"] == "EJF-GlobalSerial"
    assert trace["run"]["serial_all"] is True
    assert trace["validation"]["valid"] is True


def test_visualizer_import_trace_endpoint_accepts_external_trace(visualizer_http_server):
    trace = post_json(f"{visualizer_http_server}/api/import/trace", load_external_fixture("external_valid_trace.json"))

    assert trace["validation"]["valid"] is True
    assert trace["run"]["source_label"] == "fixture external scheduler"
    assert trace["run"]["scheduler_policy"] == "unknown_external"
    assert trace["source_claims"]["mapper"] == "external-identity-map"
    assert trace["trace_hash"]


def test_visualizer_import_trace_endpoint_rejects_invalid_external_trace(visualizer_http_server):
    with pytest.raises(urllib.error.HTTPError) as excinfo:
        post_json(
            f"{visualizer_http_server}/api/import/trace",
            load_external_fixture("external_invalid_nonadjacent_move.json"),
        )

    assert excinfo.value.code == 400
    payload = json.loads(excinfo.value.read().decode("utf-8"))
    assert payload["error"] == "Imported trace failed validation"
    assert any("not adjacent to segment:1" in detail for detail in payload["details"])


def test_visualizer_import_trace_endpoint_rejects_wrong_content_type_and_malformed_json(visualizer_http_server):
    with pytest.raises(urllib.error.HTTPError) as excinfo:
        post_json(f"{visualizer_http_server}/api/import/trace", {"bad": True}, content_type="text/plain")
    assert excinfo.value.code == 415

    request = urllib.request.Request(
        f"{visualizer_http_server}/api/import/trace",
        data=b"{bad json",
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with pytest.raises(urllib.error.HTTPError) as excinfo:
        urllib.request.urlopen(request, timeout=60)
    assert excinfo.value.code == 400
    payload = json.loads(excinfo.value.read().decode("utf-8"))
    assert "Malformed JSON" in payload["error"]


def test_visualizer_architecture_validate_endpoint_accepts_custom_qccd_graph(visualizer_http_server):
    payload = post_json(
        f"{visualizer_http_server}/api/architecture/validate",
        load_architecture_fixture("custom_linear_valid.json"),
    )

    assert payload["valid"] is True
    assert payload["status"] == "graph_valid"
    assert payload["scheduling_support"] == "qccdsim_machine_builder"
    assert payload["topology"]["traps"][1]["orientation"] == {"1": "L", "2": "R"}
    assert payload["topology"]["layout"]["trap:0"]["x"] == 0


def test_visualizer_architecture_validate_endpoint_rejects_invalid_graph(visualizer_http_server):
    with pytest.raises(urllib.error.HTTPError) as excinfo:
        post_json(
            f"{visualizer_http_server}/api/architecture/validate",
            load_architecture_fixture("custom_invalid_junction_degree.json"),
        )

    assert excinfo.value.code == 400
    payload = json.loads(excinfo.value.read().decode("utf-8"))
    assert payload["error"] == "Invalid QCCD architecture specification"
    assert any("junction 0 declared degree 3 but graph degree is 2" in detail for detail in payload["details"])


def test_visualizer_architecture_validate_endpoint_rejects_wrong_content_type_and_malformed_json(visualizer_http_server):
    with pytest.raises(urllib.error.HTTPError) as excinfo:
        post_json(f"{visualizer_http_server}/api/architecture/validate", {"bad": True}, content_type="text/plain")
    assert excinfo.value.code == 415

    request = urllib.request.Request(
        f"{visualizer_http_server}/api/architecture/validate",
        data=b"{bad json",
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with pytest.raises(urllib.error.HTTPError) as excinfo:
        urllib.request.urlopen(request, timeout=60)
    assert excinfo.value.code == 400
    payload = json.loads(excinfo.value.read().decode("utf-8"))
    assert "Malformed JSON" in payload["error"]


def test_visualizer_circuit_validate_endpoint_accepts_inline_openqasm(visualizer_http_server):
    qasm = """
    OPENQASM 2.0;
    include "qelib1.inc";
    qreg q[2];
    h q[0];
    cx q[0], q[1];
    """

    payload = post_json(f"{visualizer_http_server}/api/circuit/validate", {"qasm": qasm, "source_label": "inline bell"})

    assert payload["valid"] is True
    assert payload["source_label"] == "inline bell"
    assert payload["qubits"] == 2
    assert payload["cx"] == 1
    assert payload["recommended_initial_load_cap"] == 1
    assert payload["decomposition"]["transpiler_seed"] == 12345
    assert payload["id"].startswith("qasm:")


def test_visualizer_circuit_validate_endpoint_rejects_invalid_openqasm(visualizer_http_server):
    with pytest.raises(urllib.error.HTTPError) as excinfo:
        post_json(f"{visualizer_http_server}/api/circuit/validate", {"qasm": "OPENQASM 2.0; qreg q[2]; cx q[0], ;"})

    assert excinfo.value.code == 400
    payload = json.loads(excinfo.value.read().decode("utf-8"))
    assert payload["error"] == "Invalid OpenQASM circuit"
    assert any("OpenQASM parse failed" in detail for detail in payload["details"])


def test_visualizer_circuit_validate_endpoint_rejects_wrong_content_type_malformed_json_and_oversized_payload(
    visualizer_http_server,
):
    with pytest.raises(urllib.error.HTTPError) as excinfo:
        post_json(f"{visualizer_http_server}/api/circuit/validate", {"bad": True}, content_type="text/plain")
    assert excinfo.value.code == 415

    request = urllib.request.Request(
        f"{visualizer_http_server}/api/circuit/validate",
        data=b"{bad json",
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with pytest.raises(urllib.error.HTTPError) as excinfo:
        urllib.request.urlopen(request, timeout=60)
    assert excinfo.value.code == 400
    payload = json.loads(excinfo.value.read().decode("utf-8"))
    assert "Malformed JSON" in payload["error"]

    request = urllib.request.Request(
        f"{visualizer_http_server}/api/circuit/validate",
        data=b" " * (MAX_IMPORT_BYTES + 1),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with pytest.raises(urllib.error.HTTPError) as excinfo:
        urllib.request.urlopen(request, timeout=60)
    assert excinfo.value.code == 413
    payload = json.loads(excinfo.value.read().decode("utf-8"))
    assert payload["error"] == "Circuit payload is too large"


def test_visualizer_trace_post_generates_schedule_from_inline_openqasm(visualizer_http_server):
    qasm = """
    OPENQASM 2.0;
    include "qelib1.inc";
    qreg q[2];
    h q[0];
    cx q[0], q[1];
    rz(pi/8) q[1];
    """

    trace = post_json(
        f"{visualizer_http_server}/api/trace",
        {
            "qasm": qasm,
            "source_label": "inline bell",
            "machine": "L6",
            "capacity": 1,
            "mapper": "Greedy",
            "ordering": "Naive",
            "scheduler": "EJF",
        },
    )

    assert trace["validation"]["valid"] is True
    assert trace["run"]["program"].startswith("IMPORTED:qasm:")
    assert trace["run"]["source_label"] == "inline bell"
    assert trace["dag"]["nodes"][0]["gate_name"] == "h"
    assert any(node["gate_name"] == "cx" for node in trace["dag"]["nodes"])


def test_visualizer_trace_post_rejects_wrong_content_type_malformed_json_and_oversized_payload(
    visualizer_http_server,
):
    with pytest.raises(urllib.error.HTTPError) as excinfo:
        post_json(f"{visualizer_http_server}/api/trace", {"bad": True}, content_type="text/plain")
    assert excinfo.value.code == 415

    request = urllib.request.Request(
        f"{visualizer_http_server}/api/trace",
        data=b"{bad json",
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with pytest.raises(urllib.error.HTTPError) as excinfo:
        urllib.request.urlopen(request, timeout=60)
    assert excinfo.value.code == 400
    payload = json.loads(excinfo.value.read().decode("utf-8"))
    assert "Malformed JSON" in payload["error"]

    request = urllib.request.Request(
        f"{visualizer_http_server}/api/trace",
        data=b" " * (MAX_IMPORT_BYTES + 1),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with pytest.raises(urllib.error.HTTPError) as excinfo:
        urllib.request.urlopen(request, timeout=60)
    assert excinfo.value.code == 413
    payload = json.loads(excinfo.value.read().decode("utf-8"))
    assert payload["error"] == "Imported circuit trace payload is too large"


def test_visualizer_custom_trace_endpoint_generates_schedule_from_valid_architecture(visualizer_http_server):
    trace = post_json(
        f"{visualizer_http_server}/api/trace/custom",
        {
            "program": "qft_n4",
            "capacity": 2,
            "mapper": "Greedy",
            "ordering": "Naive",
            "scheduler": "EJF",
            "architecture": load_architecture_fixture("custom_linear_valid.json"),
        },
    )

    assert trace["validation"]["valid"] is True
    assert trace["run"]["machine"] == "CUSTOM:custom_linear_3"
    assert trace["topology"]["traps"][1]["orientation"] == {"1": "L", "2": "R"}
    assert trace["topology"]["layout"]["trap:2"]["x"] == 480
    assert trace["metrics"]["event_count"] == len(trace["events"])


def test_visualizer_program_catalog_has_feasible_demo_configurations():
    max_capacity = max(CAPACITIES)
    largest_machine_slots = max(_machine_trap_count(machine, max_capacity) * max_capacity for machine in ["L6", "G2x3", "G3x3", "G9", "T4x2", "T6x3", "T8x4", "H6"])

    impossible = [
        (program_id, program.get("qubits"))
        for program_id, program in PROGRAMS.items()
        if int(program.get("qubits") or 0) > largest_machine_slots
    ]

    assert impossible == []


def test_visualizer_trace_endpoint_rejects_infeasible_capacity(visualizer_http_server):
    query = urllib.parse.urlencode(
        {
            "program": "cat_state_n22",
            "machine": "G3x3",
            "capacity": "1",
            "mapper": "Greedy",
        }
    )

    with pytest.raises(urllib.error.HTTPError) as excinfo:
        read_json(f"{visualizer_http_server}/api/trace?{query}")

    assert excinfo.value.code == 400
    payload = json.loads(excinfo.value.read().decode("utf-8"))
    assert "requires 22 logical qubits" in payload["error"]


def test_visualizer_trace_endpoint_rejects_demo_unsafe_capacity(visualizer_http_server):
    query = urllib.parse.urlencode(
        {
            "program": "hhl_n7",
            "machine": "G3x3",
            "capacity": "1",
            "mapper": "Greedy",
            "ordering": "Naive",
            "scheduler": "EJF",
        }
    )

    with pytest.raises(urllib.error.HTTPError) as excinfo:
        read_json(f"{visualizer_http_server}/api/trace?{query}")

    assert excinfo.value.code == 400
    payload = json.loads(excinfo.value.read().decode("utf-8"))
    assert "Generated trace failed validation" in payload["error"]
