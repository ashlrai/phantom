#!/usr/bin/env python3
"""Fresh-context judge gate (RQ-SWE5-FRESH-JUDGE, research digest item 2).

publish.sh calls this before arming auto-merge. The judge sees ONLY the diff, the
job's done-contract and captured CI/test evidence: never the producer's notes or
reasoning (build_packet takes no such input). The judge command (PUBLISH_JUDGE_CMD,
argv split with shlex, no shell) reads the packet on stdin and prints JSON:
{"verdict": "pass"|"fail", "confidence": 0..1, "reasons": [...]}.

Prints one line `JUDGE <pass|fail|leader-review> conf=<c> <reasons>` and exits 0 only
for pass. Everything else (fail, low confidence, timeout, garbage output, judge
missing) is fail-closed: auto-merge stays unarmed and the PR goes to leader review.
"""
import argparse
import json
import os
import shlex
import subprocess
import sys

DIFF_CAP = 200_000
EVIDENCE_CAP = 20_000
DEFAULT_THRESHOLD = 0.8
DEFAULT_TIMEOUT = 600

INSTRUCTIONS = (
    "You are an independent code judge with no knowledge of how this change was produced. "
    "Decide from the DIFF, the DONE CONTRACT and the EVIDENCE alone whether the change "
    "satisfies the contract, is correct and tested, and is safe to auto-merge. "
    'Reply with JSON only: {"verdict":"pass"|"fail","confidence":0..1,"reasons":["..."]}.'
)


def _clip(text, cap, keep_tail=False):
    if len(text) <= cap:
        return text
    return ("[...truncated...]\n" + text[-cap:]) if keep_tail else (text[:cap] + "\n[...truncated...]")


def build_packet(diff, contract, evidence):
    """The only inputs a judge may receive. Producer notes are deliberately not a parameter."""
    return "\n\n".join((
        INSTRUCTIONS,
        "=== DONE CONTRACT ===\n" + contract.strip(),
        "=== EVIDENCE (CI/test output) ===\n" + _clip(evidence.strip() or "none captured", EVIDENCE_CAP, keep_tail=True),
        "=== DIFF ===\n" + _clip(diff, DIFF_CAP),
    )) + "\n"


def parse_verdict(raw):
    """Return (verdict, confidence, reasons); malformed output is a fail with confidence 0."""
    start, end = raw.find("{"), raw.rfind("}")
    try:
        data = json.loads(raw[start:end + 1])
        verdict = data["verdict"]
        conf = float(data.get("confidence", 0))
        reasons = [str(r) for r in data.get("reasons", [])][:5]
    except (ValueError, KeyError, TypeError, AttributeError):
        return "fail", 0.0, ["unparseable judge output"]
    if verdict not in ("pass", "fail") or not 0 <= conf <= 1:
        return "fail", 0.0, ["invalid judge verdict"]
    return verdict, conf, reasons


def decide(verdict, conf, threshold):
    if verdict == "pass" and conf >= threshold:
        return "pass"
    return "fail" if verdict == "fail" and conf >= threshold else "leader-review"


def run_judge(cmd, packet, timeout):
    try:
        done = subprocess.run(shlex.split(cmd), input=packet, capture_output=True, text=True, timeout=timeout)
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        return "fail", 0.0, [f"judge unavailable: {type(exc).__name__}"]
    if done.returncode != 0:
        return "fail", 0.0, [f"judge exit {done.returncode}"]
    return parse_verdict(done.stdout)


def _read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except OSError:
        return ""


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--diff", required=True)
    ap.add_argument("--contract", required=True)
    ap.add_argument("--evidence", default="")
    ap.add_argument("--threshold", type=float, default=float(os.environ.get("PUBLISH_JUDGE_THRESHOLD", DEFAULT_THRESHOLD)))
    ap.add_argument("--timeout", type=int, default=int(os.environ.get("PUBLISH_JUDGE_TIMEOUT", DEFAULT_TIMEOUT)))
    args = ap.parse_args(argv)
    contract = _read(args.contract)
    if not contract.strip():
        print("JUDGE leader-review conf=0.00 no done-contract available")
        return 1
    cmd = os.environ.get("PUBLISH_JUDGE_CMD", "")
    packet = build_packet(_read(args.diff), contract, _read(args.evidence) if args.evidence else "")
    verdict, conf, reasons = run_judge(cmd, packet, args.timeout) if cmd else ("fail", 0.0, ["no PUBLISH_JUDGE_CMD"])
    outcome = decide(verdict, conf, args.threshold)
    print(f"JUDGE {outcome} conf={conf:.2f} " + "; ".join(r.replace("\n", " ")[:200] for r in reasons))
    return 0 if outcome == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
