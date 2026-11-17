#!/usr/bin/env python3
"""Run Polarboard's end-to-end tests.

    python3 tests/run.py              # everything
    python3 tests/run.py writing ui   # only tests/test_writing.py and tests/test_ui.py
    python3 tests/run.py --shots DIR  # also save screenshots to DIR

Each test file gets a fresh server and data folder. Exit code is non-zero if anything fails.
"""

import importlib.util
import sys
import time
import traceback
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent))
from harness import Suite  # noqa: E402


def main():
    args = sys.argv[1:]
    shots = None
    if "--shots" in args:
        i = args.index("--shots")
        shots = Path(args[i + 1])
        shots.mkdir(parents=True, exist_ok=True)
        del args[i:i + 2]
    files = sorted(Path(__file__).parent.glob("test_*.py"))
    if args:
        files = [f for f in files if f.stem[5:] in args]
    total_pass, failures, started = 0, [], time.time()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for f in files:
            name = f.stem[5:]
            print(f"\n\033[1m{name}\033[0m")
            spec = importlib.util.spec_from_file_location(f.stem, f)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            t = Suite(name, browser, shots)
            try:
                mod.run(t)
            except Exception:
                t.failed.append("crashed: " + traceback.format_exc().strip().splitlines()[-1])
                print(traceback.format_exc())
            finally:
                if t.server:
                    errors = t.server.errors()
                    t.ok(not errors, "server logged no errors" + (f": {errors[:3]}" if errors else ""))
                    t.server.stop()
            t.ok(not t.page_errors, "no page errors" + (f": {t.page_errors[:3]}" if t.page_errors else ""))
            total_pass += t.passed
            failures += [f"{name}: {m}" for m in t.failed]
        browser.close()
    print(f"\n{total_pass} passed, {len(failures)} failed in {time.time() - started:.0f}s")
    for m in failures:
        print(f"  - {m}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
