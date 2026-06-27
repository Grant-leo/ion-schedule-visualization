import subprocess as sp
import sys

PROG=["programs/bv64_cut.qasm"]

MACHINE=["L6"]

IONS = ["2"]
# for i in range(14, 35, 2):
#     IONS.append(str(i))
# print(IONS)

mapper = "Greedy"
reorder = "Naive"

with open('output.log','w') as output_file:
    for p in PROG:
        for m in MACHINE:
            for i in IONS:
                sp.run(
                    [sys.executable, "run.py", p, m, i, mapper, reorder, "1", "0", "0", "FM", "GateSwap"],
                    stdout=output_file,
                    stderr=sp.STDOUT,
                    check=True,
                )
