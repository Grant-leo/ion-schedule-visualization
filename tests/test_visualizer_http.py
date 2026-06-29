import json
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

from visualizer_server import VisualizerHandler
from visualizer_server import STATIC_DIR


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
    assert 'id="benchmarkMetaPanel"' in html
    assert 'id="runConfigPanel"' in html


def test_visualizer_medium_viewport_uses_uncramped_layout_breakpoint():
    css = (STATIC_DIR / "styles.css").read_text(encoding="utf-8")

    assert "@media (max-width: 1240px)" in css
    assert "@media (max-width: 1360px)" not in css
    assert "grid-template-areas:\n      \"header header\"\n      \"left viewport\"\n      \"right right\"" in css


def test_visualizer_desktop_dag_inspector_spans_full_page_height():
    css = (STATIC_DIR / "styles.css").read_text(encoding="utf-8")

    assert "grid-template-areas:\n    \"header header right\"\n    \"left viewport right\"\n    \"timeline timeline right\"" in css
    assert "height: 100vh;\n  overflow: auto;" in css
    assert "min-height: calc(100vh - (var(--space-5) * 2));" in css


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
