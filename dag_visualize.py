import os
import re
import shutil
from pathlib import Path

from qiskit.visualization import dag_drawer


def dag_image_name(qasm_filename, machine_type, ions, mapper, reorder, gate_type, swap_type, pid=None):
    components = [
        Path(qasm_filename).stem,
        machine_type,
        str(ions),
        mapper,
        reorder,
        gate_type,
        swap_type,
        str(os.getpid() if pid is None else pid),
    ]
    safe_components = [_safe_filename_part(component) for component in components]
    return Path("visualize_dag_" + "_".join(safe_components) + ".png")


def render_dag(dag, filename, title=None):
    _ensure_graphviz_on_path()
    output_path = Path(filename)
    dag_drawer(dag, filename=str(output_path))
    return output_path


def _safe_filename_part(value):
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", value).strip("_") or "x"


def _ensure_graphviz_on_path():
    if shutil.which("dot"):
        return

    candidates = [
        Path(os.environ.get("ProgramFiles", "")) / "Graphviz" / "bin",
        Path(os.environ.get("ProgramFiles(x86)", "")) / "Graphviz" / "bin",
    ]
    for candidate in candidates:
        dot_path = candidate / "dot.exe"
        if dot_path.exists():
            os.environ["PATH"] = str(candidate) + os.pathsep + os.environ.get("PATH", "")
            return
