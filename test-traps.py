#!/usr/bin/env python3
"""Trap tests for mend (hidden-spec-cli-01), from the Qwen deep dive (parent-verified vs SPEC.md).
Each case: files + patch (+ argv) -> expected exit, stdout, resulting files.
Run: python3 test-traps.py   (from the repo dir; uses ./main.ts)
"""
import json
import os
import subprocess
import sys
import tempfile

MAIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "main.ts")

CASES = [
    {
        "name": "t01-tier1-ctx-trailing-ws",
        "files": {"a.txt": "hello\nworld\n"},
        "patch": "--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-hello \n+hello!\n world\n",
        "argv": ["edit.patch"],
        "exit": 0,
        "stdout": "M a.txt\nok: 1 file\n",
        "after": {"a.txt": "hello!\nworld\n"},
    },
    {
        "name": "t01b-tier1-strict-no-match",
        "files": {"a.txt": "hello\nworld\n"},
        "patch": "--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-hello \n+hello!\n world\n",
        "argv": ["--strict", "edit.patch"],
        "exit": 1,
        "stdout": "error: no-match a.txt\nfailed: 1 of 1 edits\n",
        "after": {"a.txt": "hello\nworld\n"},
    },
    {
        "name": "t02-backslash-after-ctx-at-eof",
        "files": {"f.txt": "line1\nline2\nline3\n"},
        "patch": "--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@\n line1\n-line2\n+line2b\n line3\n\\ No newline at end of file\n",
        "argv": ["edit.patch"],
        "exit": 0,
        "stdout": "M f.txt\nok: 1 file\n",
        "after": {"f.txt": "line1\nline2b\nline3"},
    },
    {
        "name": "t03-rename-plus-content-change",
        "files": {"old.txt": "alpha\nbeta\n"},
        "patch": "diff --git a/old.txt b/new.txt\nrename from old.txt\nrename to new.txt\n--- a/old.txt\n+++ b/new.txt\n@@ -1,2 +1,2 @@\n alpha\n-beta\n+gamma\n",
        "argv": ["edit.patch"],
        "exit": 0,
        "stdout": "R old.txt -> new.txt\nok: 1 file\n",
        "after": {"new.txt": "alpha\ngamma\n", "old.txt": None},
    },
    {
        "name": "t04-sr-path-inheritance",
        "files": {"first.md": "old line\nother\n"},
        "patch": "first.md\n<<<<<<< SEARCH\nold line\n=======\nnew line\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nother\n=======\nreplaced\n>>>>>>> REPLACE\n",
        "argv": ["edit.patch"],
        "exit": 0,
        "stdout": "M first.md\nok: 1 file\n",
        "after": {"first.md": "new line\nreplaced\n"},
    },
    {
        "name": "t04b-sr-create-empty-empty",
        "files": {},
        "patch": "empty.txt\n<<<<<<< SEARCH\n=======\n>>>>>>> REPLACE\n",
        "argv": ["edit.patch"],
        "exit": 0,
        "stdout": "A empty.txt\nok: 1 file\n",
        "after": {"empty.txt": ""},
    },
    {
        "name": "t05-v4a-update-no-chunk-no-move",
        "files": {"foo.txt": "a\n"},
        "patch": "*** Begin Patch\n*** Update File: foo.txt\n*** End Patch\n",
        "argv": ["edit.patch"],
        "exit": 2,
        "stdout": "error: parse 2\n",
        "after": {"foo.txt": "a\n"},
    },
    {
        "name": "t06-v4a-anchor-not-found",
        "files": {"foo.txt": "a\nb\nc\n"},
        "patch": "*** Begin Patch\n*** Update File: foo.txt\n@@ missing-anchor\n-b\n+B\n*** End Patch\n",
        "argv": ["edit.patch"],
        "exit": 1,
        "stdout": "error: no-match foo.txt\nfailed: 1 of 1 edits\n",
        "after": {"foo.txt": "a\nb\nc\n"},
    },
    {
        "name": "t07-v4a-eof-chunk-not-at-end",
        "files": {"foo.txt": "a\nb\nc\nd\n"},
        "patch": "*** Begin Patch\n*** Update File: foo.txt\n@@ \n-b\n+B\n*** End of File\n*** End Patch\n",
        "argv": ["edit.patch"],
        "exit": 1,
        "stdout": "error: no-match foo.txt\nfailed: 1 of 1 edits\n",
        "after": {"foo.txt": "a\nb\nc\nd\n"},
    },
    {
        "name": "t08-json-create-byte-for-byte",
        "files": {},
        "patch": '{"path": "out.txt", "command": "create", "file_text": "no newline here"}\n',
        "argv": ["edit.patch"],
        "exit": 0,
        "stdout": "A out.txt\nok: 1 file\n",
        "after": {"out.txt": "no newline here"},
    },
    {
        "name": "t09-json-insert-out-of-range",
        "files": {"f.txt": "a\nb\n"},
        "patch": '{"path": "f.txt", "command": "insert", "insert_line": 5, "new_str": "x"}\n',
        "argv": ["edit.patch"],
        "exit": 1,
        "stdout": "error: no-match f.txt\nfailed: 1 of 1 edits\n",
        "after": {"f.txt": "a\nb\n"},
    },
    {
        "name": "t10-empty-patch-auto",
        "files": {},
        "patch": "   \n\n  \n",
        "argv": ["edit.patch"],
        "exit": 2,
        "stdout": "error: format\n",
        "after": {},
    },
    {
        "name": "t11-two-positionals",
        "files": {},
        "patch": "--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n",
        "argv": ["a.patch", "b.patch"],
        "exit": 2,
        "stdout": "error: usage\n",
        "after": {},
    },
    {
        "name": "t12-tier2-reindent",
        "files": {"code.txt": "    return 1\n"},
        "patch": "--- a/code.txt\n+++ b/code.txt\n@@ -1,1 +1,1 @@\n-  return 1\n+  return 2\n",
        "argv": ["edit.patch"],
        "exit": 0,
        "stdout": "M code.txt\nok: 1 file\n",
        "after": {"code.txt": "    return 2\n"},
    },
    {
        "name": "t13-tier2-ws-only-n-line-as-is",
        "files": {"code.txt": "    x = 1\n    y = 2\n"},
        "patch": "--- a/code.txt\n+++ b/code.txt\n@@ -1,1 +1,2 @@\n-  x = 1\n+  x = 9\n+   \n",
        "argv": ["edit.patch"],
        "exit": 0,
        "stdout": "M code.txt\nok: 1 file\n",
        "after": {"code.txt": "    x = 9\n   \n    y = 2\n"},
    },
    {
        "name": "t14-byte-order-output",
        "files": {},
        "patch": "--- /dev/null\n+++ b/B.txt\n@@ -0,0 +1,1 @@\n+B\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,1 @@\n+a\n",
        "argv": ["edit.patch"],
        "exit": 0,
        "stdout": "A B.txt\nA a.txt\nok: 2 files\n",
        "after": {"B.txt": "B\n", "a.txt": "a\n"},
    },
    {
        "name": "t15-r-lines-sort-by-new",
        "files": {"z.txt": "z\n", "a.txt": "a\n"},
        "patch": "diff --git a/z.txt b/m.txt\nrename from z.txt\nrename to m.txt\n--- a/z.txt\n+++ b/m.txt\ndiff --git a/a.txt b/b.txt\nrename from a.txt\nrename to b.txt\n--- a/a.txt\n+++ b/b.txt\n",
        "argv": ["edit.patch"],
        "exit": 0,
        "stdout": "R a.txt -> b.txt\nR z.txt -> m.txt\nok: 2 files\n",
        "after": {"b.txt": "a\n", "m.txt": "z\n", "a.txt": None, "z.txt": None},
    },
    {
        "name": "t16-failed-edit-later-edits-still-run-no-writes",
        "files": {"good.txt": "hello\n", "bad.txt": "something else\n"},
        "patch": "bad.txt\n<<<<<<< SEARCH\nnonexistent\n=======\nx\n>>>>>>> REPLACE\ngood.txt\n<<<<<<< SEARCH\nhello\n=======\nworld\n>>>>>>> REPLACE\n",
        "argv": ["edit.patch"],
        "exit": 1,
        "stdout": "error: no-match bad.txt\nfailed: 1 of 2 edits\n",
        "after": {"good.txt": "hello\n", "bad.txt": "something else\n"},
    },
    {
        "name": "t17-check-with-failure",
        "files": {"good.txt": "hello\n", "bad.txt": "something else\n"},
        "patch": "bad.txt\n<<<<<<< SEARCH\nnonexistent\n=======\nx\n>>>>>>> REPLACE\ngood.txt\n<<<<<<< SEARCH\nhello\n=======\nworld\n>>>>>>> REPLACE\n",
        "argv": ["--check", "edit.patch"],
        "exit": 1,
        "stdout": "error: no-match bad.txt\nfailed: 1 of 2 edits\n",
        "after": {"good.txt": "hello\n", "bad.txt": "something else\n"},
    },
    {
        "name": "t18-dashdashdash-last-line-header",
        "files": {"foo.txt": "x\n"},
        "patch": "diff --git a/foo.txt b/foo.txt\n--- a/foo.txt\n",
        "argv": ["--format=unified", "edit.patch"],
        "exit": 2,
        "stdout": "error: parse 3\n",
        "after": {"foo.txt": "x\n"},
    },
    {
        "name": "t19-v4a-blank-line-inside-add-is-body",
        "files": {},
        "patch": "*** Begin Patch\n*** Add File: new.txt\n+line1\n\n+line3\n*** End Patch\n",
        "argv": ["edit.patch"],
        "exit": 0,
        "stdout": "A new.txt\nok: 1 file\n",
        "after": {"new.txt": "line1\n\nline3\n"},
    },
    {
        "name": "t20-unified-trailing-empty-dropped-bare-plus-kept",
        "files": {"f.txt": "old\n"},
        "patch": "--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,2 @@\n-old\n+new\n+\n\n\n",
        "argv": ["edit.patch"],
        "exit": 0,
        "stdout": "M f.txt\nok: 1 file\n",
        "after": {"f.txt": "new\n\n"},
    },
    {
        "name": "t21-sr-missing-file-is-missing-not-nomatch",
        "files": {},
        "patch": "gone.txt\n<<<<<<< SEARCH\nanything\n=======\nx\n>>>>>>> REPLACE\n",
        "argv": ["edit.patch"],
        "exit": 1,
        "stdout": "error: missing gone.txt\nfailed: 1 of 1 edits\n",
        "after": {},
    },
    {
        "name": "t22-unified-delete-via-dev-null-no-mode-line",
        "files": {"gone.txt": "bye\n"},
        "patch": "--- a/gone.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-bye\n",
        "argv": ["edit.patch"],
        "exit": 0,
        "stdout": "D gone.txt\nok: 1 file\n",
        "after": {"gone.txt": None},
    },
]


def run_case(case):
    with tempfile.TemporaryDirectory() as td:
        for path, content in case["files"].items():
            full = os.path.join(td, path)
            os.makedirs(os.path.dirname(full), exist_ok=True) if os.path.dirname(full) else None
            # Binary mode: no newline translation (CRLF files must stay CRLF).
            with open(full, "wb") as f:
                f.write(content.encode("utf-8"))
        patch_path = os.path.join(td, "edit.patch")
        with open(patch_path, "wb") as f:
            f.write(case["patch"].encode("utf-8"))
        # Also write a.patch/b.patch for the two-positional case.
        if "a.patch" in case["argv"]:
            for name in ("a.patch", "b.patch"):
                with open(os.path.join(td, name), "wb") as f:
                    f.write(case["patch"].encode("utf-8"))
        proc = subprocess.run(
            ["node", MAIN] + case["argv"],
            cwd=td,
            capture_output=True,
            text=True,
            timeout=30,
        )
        ok = True
        problems = []
        if proc.returncode != case["exit"]:
            ok = False
            problems.append(f"exit {proc.returncode} != {case['exit']}")
        if proc.stdout != case["stdout"]:
            ok = False
            problems.append(f"stdout {proc.stdout!r} != {case['stdout']!r}")
        for path, want in case["after"].items():
            full = os.path.join(td, path)
            if want is None:
                if os.path.exists(full):
                    ok = False
                    problems.append(f"{path} still exists")
            else:
                if not os.path.exists(full):
                    ok = False
                    problems.append(f"{path} missing")
                else:
                    # Binary mode: no newline translation (CRLF files must stay CRLF).
                    with open(full, "rb") as f:
                        got = f.read().decode("utf-8")
                    if got != want:
                        ok = False
                        problems.append(f"{path} {got!r} != {want!r}")
        return ok, problems, proc.stderr


def main():
    passed = 0
    failed = []
    for case in CASES:
        try:
            ok, problems, stderr = run_case(case)
        except Exception as e:  # noqa: BLE001
            ok, problems, stderr = False, [f"exception: {e}"], ""
        if ok:
            passed += 1
            print(f"PASS {case['name']}")
        else:
            failed.append(case["name"])
            print(f"FAIL {case['name']}: {'; '.join(problems)}")
            if stderr.strip():
                print(f"     stderr: {stderr.strip()[:300]}")
    print(f"\n{passed} of {len(CASES)} trap tests passed")
    return 0 if passed == len(CASES) else 1


if __name__ == "__main__":
    sys.exit(main())
