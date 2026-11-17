# Tests

End-to-end tests that start a real server on a throwaway data folder and drive the app in Chromium.

```sh
pip install playwright pillow && playwright install chromium   # once
python3 tests/run.py                 # everything (about three minutes)
python3 tests/run.py writing ui      # just tests/test_writing.py and tests/test_ui.py
python3 tests/run.py --shots /tmp/s  # also save screenshots
```

Each `test_*.py` file has a `run(t)` function. `t.start()` starts a server, `t.page()` opens a browser page,
and `t.ok(condition, "what should be true")` records a check. Page errors, failed requests and server
errors fail the file automatically.

`tests/fix_imports.py` keeps the imports between the modules in `static/app/` complete: after using a
function from another module, run it to add the import (`--check` only reports, and `test_polish.py`
runs that check). It adds imports but never removes them.
