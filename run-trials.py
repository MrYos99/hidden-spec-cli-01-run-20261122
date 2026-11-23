#!/usr/bin/env python3
"""Run main.ts against the kit's practice trial dirs (practice/trial-N), mirroring check.ts.
Usage: python3 run-trials.py [trial numbers...]   (default: 0 1 2)
Compares exit, stdout and the full final file tree against reference/expected.json.
"""
import json
import os
import subprocess
import sys
import tempfile

BASE = "/home/hatch/workspace/makefun/hidden-spec-cli-01/hidden-spec-cli-01-run-20261122-kit"
MAIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "main.ts")


def run_trial(t):
    checks = json.load(open(f"{BASE}/practice/trial-{t}/input/env/checks.json"))["checks"]
    expected = json.load(open(f"{BASE}/practice/trial-{t}/reference/expected.json"))["checks"]
    exp_by_id = {e["id"]: e for e in expected}
    passed = 0
    failures = []
    for c in checks:
        e = exp_by_id[c["id"]]
        with tempfile.TemporaryDirectory() as td:
            for path, content in c["files"].items():
                full = os.path.join(td, path)
                parent = os.path.dirname(full)
                if parent:
                    os.makedirs(parent, exist_ok=True)
                # Binary mode: no newline translation (CRLF files must stay CRLF).
                with open(full, "wb") as f:
                    f.write(content.encode("utf-8"))
            proc = subprocess.run(
                ["node", MAIN] + c["argv"],
                cwd=td,
                input=c["stdin"],
                capture_output=True,
                text=True,
                timeout=30,
            )
            got_files = {}
            for root, _dirs, names in os.walk(td):
                for name in names:
                    full = os.path.join(root, name)
                    rel = os.path.relpath(full, td)
                    # Binary mode: no newline translation (CRLF files must stay CRLF).
                    with open(full, "rb") as f:
                        got_files[rel] = f.read().decode("utf-8")
            want = e["files"]
            why = []
            if proc.returncode != e["exit"]:
                why.append(f"exit {proc.returncode}, expected {e['exit']}")
            if proc.stdout != e["stdout"]:
                why.append(f"stdout {proc.stdout!r}, expected {e['stdout']!r}")
            for p in sorted(set(want) | set(got_files)):
                if p not in want:
                    why.append(f"{p} should not exist")
                elif p not in got_files:
                    why.append(f"{p} is missing")
                elif got_files[p] != want[p]:
                    why.append(f"{p} differs: expected {want[p]!r}, got {got_files[p]!r}")
            if not why:
                passed += 1
            else:
                failures.append((c["id"], e["group"], why))
    return passed, len(checks), failures


def main():
    trials = [int(x) for x in sys.argv[1:]] or [0, 1, 2]
    total_pass = 0
    total = 0
    for t in trials:
        passed, n, failures = run_trial(t)
        total_pass += passed
        total += n
        print(f"trial-{t}: {passed} of {n} passed")
        for cid, group, why in failures:
            print(f"  FAIL {group} {cid}:")
            for w in why:
                print(f"    {w}")
    print(f"total: {total_pass} of {total} passed")
    return 0 if total_pass == total else 1


if __name__ == "__main__":
    sys.exit(main())
