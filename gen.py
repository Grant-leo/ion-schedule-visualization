def main():
    try:
        from qcg.generators import gen_adder
    except ImportError as exc:
        raise SystemExit("gen.py requires the optional qcg package to generate circuits") from exc

    circ = gen_adder(nbits=32)
    print(circ.qasm())


if __name__ == "__main__":
    main()
