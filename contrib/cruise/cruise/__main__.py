import argparse, json, sys
from . import runner, sensors


def main(argv=None):
    ap = argparse.ArgumentParser(prog="cruise")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("tick", help="one shadow tick against ~/.ashlr-runs")
    sub.add_parser("sample", help="print one OS-sensor sample")
    b = sub.add_parser("baseline", help="sessions, merges/hour and pause events from ~/.ashlr-runs files")
    b.add_argument("--hours", type=float, action="append")
    r = sub.add_parser("report", help="shadow vs dispatchd summary")
    r.add_argument("--hours", type=float, default=24)
    a = ap.parse_args(argv)
    if a.cmd == "tick":
        print(json.dumps(runner.tick(), default=str)[:2000])
    elif a.cmd == "sample":
        print(json.dumps(sensors.detect().sample().to_dict(), indent=1))
    elif a.cmd == "baseline":
        from .metrics import baseline
        print(json.dumps(baseline(runner.Paths(), a.hours or [24, 168]), indent=1))
    elif a.cmd == "report":
        from .metrics import shadow_report
        print(json.dumps(shadow_report(runner.Paths(), a.hours), indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
