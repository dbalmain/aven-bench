#!/usr/bin/env python3
"""Run a generated Python suite and report results in aven-bench's shape.

Usage: py_runner.py <suite-module> [working-dir]

Emits the same JSON envelope as `aven test --format json`, and the same exit
code contract, so the runner can read both arms with one parser:

    {"ok": bool, "total": n, "passed": n, "failed": n, "errored": n,
     "cases": [{"name": str, "outcome": "pass"|"fail"|"error", "message": str}]}

    0  every case passed
    1  the suite ran, at least one case failed or errored
    2  the suite could not be loaded (missing/broken solution or suite)
"""

import json
import os
import sys
import time
import traceback
import unittest


def emit(payload, code):
    json.dump(payload, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    sys.stdout.flush()
    raise SystemExit(code)


def load_error(message):
    emit(
        {
            "ok": False,
            "total": 0,
            "passed": 0,
            "failed": 0,
            "errored": 0,
            "cases": [],
            "load_error": message,
        },
        2,
    )


def main(argv):
    if len(argv) < 2:
        load_error("usage: py_runner.py <suite-module> [working-dir]")
    module_name = argv[1]
    workdir = argv[2] if len(argv) > 2 else os.getcwd()
    sys.path.insert(0, workdir)

    try:
        suite = unittest.defaultTestLoader.loadTestsFromName(module_name)
    except Exception:
        load_error(traceback.format_exc(limit=4))

    # loadTestsFromName swallows import failures into a synthetic failing test;
    # detect that so a missing solution reports as "could not run", not "failed".
    if suite.countTestCases() == 1:
        only = list(suite)[0]
        while isinstance(only, unittest.TestSuite):
            children = list(only)
            if len(children) != 1:
                break
            only = children[0]
        if type(only).__name__ == "_FailedTest":
            result = unittest.TestResult()
            only.run(result)
            detail = (result.errors + result.failures)[0][1] if (result.errors or result.failures) else ""
            load_error(detail)

    def walk(node):
        if isinstance(node, unittest.TestSuite):
            for child in node:
                yield from walk(child)
        else:
            yield node

    # Snapshot before running: TestSuite.run() nulls out each entry as it goes.
    tests = list(walk(suite))

    result = unittest.TestResult()
    started = time.perf_counter()
    suite.run(result)
    duration_ms = (time.perf_counter() - started) * 1000.0

    outcomes = {}
    for test, message in result.failures:
        outcomes[test.id()] = ("fail", message)
    for test, message in result.errors:
        outcomes[test.id()] = ("error", message)

    cases = []
    for test in tests:
        outcome, message = outcomes.get(test.id(), ("pass", ""))
        cases.append(
            {
                "name": test.shortDescription() or test.id().rsplit(".", 1)[-1],
                "outcome": outcome,
                "message": message,
            }
        )

    failed = len(result.failures)
    errored = len(result.errors)
    total = len(cases)
    emit(
        {
            "ok": failed == 0 and errored == 0,
            "total": total,
            "passed": total - failed - errored,
            "failed": failed,
            "errored": errored,
            "duration_ms": duration_ms,
            "cases": cases,
        },
        0 if failed == 0 and errored == 0 else 1,
    )


if __name__ == "__main__":
    main(sys.argv)
