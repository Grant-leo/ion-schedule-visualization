import json
from pathlib import Path

from trace_export import validate_trace


ROOT = Path(__file__).resolve().parents[1]
VISUALIZER_DIR = ROOT / "visualizer"
MANIFEST_PATH = VISUALIZER_DIR / "traces" / "manifest.json"


def test_demo_trace_manifest_entries_are_valid_backend_traces():
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

    assert len(manifest) >= 4

    for entry in manifest:
        trace_path = VISUALIZER_DIR / entry["path"]
        assert trace_path.exists(), f"missing demo trace: {entry['path']}"

        trace = json.loads(trace_path.read_text(encoding="utf-8"))
        validation = validate_trace(trace)

        assert validation["valid"] is True, f"{entry['id']}: {validation['errors']}"
        assert trace["metrics"]["event_count"] == len(trace["events"]), entry["id"]
