from pathlib import Path

from ejf_schedule import EJFSchedule
from parse import InputParse
from schedule import Schedule
from test_machines import make_linear_machine

from tests.test_smoke import make_machine_params


def test_single_qubit_gates_are_scheduled_and_timed(tmp_path):
    qasm = tmp_path / "single_qubit.qasm"
    qasm.write_text(
        """
        OPENQASM 2.0;
        include "qelib1.inc";
        qreg q[2];
        h q[0];
        rz(pi/2) q[1];
        cx q[0], q[1];
        x q[0];
        """,
        encoding="utf-8",
    )

    params = make_machine_params()
    params.single_qubit_gate_time = 7
    machine = make_linear_machine(1, 4, params)
    parser = InputParse()
    parser.parse_ir(str(qasm))

    scheduler = EJFSchedule(
        parser.gate_graph,
        parser.cx_gate_map,
        machine,
        {0: [0, 1]},
        1,
        0,
        0,
        gate_qubit_map=parser.gate_qubit_map,
        gate_name_map=parser.gate_name_map,
    )
    scheduler.run()

    gate_events = [event for event in scheduler.schedule.events if event[1] == Schedule.Gate]
    arities = [event[4]["arity"] for event in gate_events]

    assert arities == [1, 1, 2, 1]
    assert scheduler.schedule.get_last_event_ts() == 121
