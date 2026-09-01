"""check_table — the formula write → check → fix loop.

The evaluator is an external command (the reference is the canvas-react
formula CLI). Most tests use a small Python stand-in so the plumbing and
report format are covered without Node; one end-to-end test runs the real
CLI when the built file and Node are available.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest

from langchain_canvas import InMemoryCanvasStore, create_check_table_tool, encode_table


@dataclass
class _Runtime:
    context: Any = None
    config: dict[str, Any] = field(default_factory=dict)


def _runtime(thread_id: str = "t1") -> _Runtime:
    return _Runtime(config={"configurable": {"thread_id": thread_id}})


# A stand-in evaluator: formulas containing FILTER fail, everything else is 42.
_FAKE_EVALUATOR = (
    sys.executable,
    "-c",
    (
        "import json,sys; p=json.load(sys.stdin); r=[];\n"
        "[r.append({'row': i, 'col': c, 'key': col['key'], 'formula': v,\n"
        "           'value': '#ERR' if 'FILTER' in v else 42})\n"
        " for i,row in enumerate(p['rows'])\n"
        " for c,col in enumerate(p['columns'])\n"
        " if isinstance(v := row.get(col['key']), str) and v.startswith('=')];\n"
        "print(json.dumps({'results': r}))"
    ),
)


# A sheets-capable stand-in: grid formulas containing XLOOKUP fail, others are 42.
_GRID_EVALUATOR = (
    sys.executable,
    "-c",
    (
        "import json,sys; p=json.load(sys.stdin); r=[]\n"
        "for i,s in enumerate(p.get('sheets') or []):\n"
        "    for cell in s.get('celldata') or []:\n"
        "        v=cell.get('v')\n"
        "        f=v.get('f') if isinstance(v,dict) else None\n"
        "        if f: r.append({'sheet': i, 'r': cell['r'], 'c': cell['c'],\n"
        "                        'formula': f, 'value': '#ERR' if 'XLOOKUP' in f else 42})\n"
        "print(json.dumps({'results': r}))"
    ),
)


def _store_with(rows: list[dict], columns: list[dict] | None = None) -> InMemoryCanvasStore:
    store = InMemoryCanvasStore()
    data = {"columns": columns or [{"key": "a"}, {"key": "t"}], "rows": rows}
    store.write("t1", "calc.table.json", encode_table("Calc", data), "seed", actor="agent")
    return store


def test_rejects_non_table_paths_and_missing_files():
    tool_obj = create_check_table_tool(InMemoryCanvasStore(), evaluator=_FAKE_EVALUATOR)
    assert "reads .table.json" in tool_obj.func(path="page.html", runtime=_runtime())
    assert "list_canvas_files" in tool_obj.func(path="nope.table.json", runtime=_runtime())


def test_no_formula_cells_reports_zero_errors_without_running_the_evaluator():
    store = _store_with([{"a": 1, "t": 2}])
    tool_obj = create_check_table_tool(store, evaluator=("this-command-does-not-exist",))
    assert tool_obj.func(path="calc.table.json", runtime=_runtime()).startswith("0 ERROR")


def test_missing_evaluator_degrades_honestly():
    store = _store_with([{"a": 1, "t": "=SUM(A2:A2)"}])
    tool_obj = create_check_table_tool(store)  # no evaluator configured
    message = tool_obj.func(path="calc.table.json", runtime=_runtime())
    assert "NOT verified" in message


def test_broken_evaluator_degrades_honestly():
    store = _store_with([{"a": 1, "t": "=SUM(A2:A2)"}])
    tool_obj = create_check_table_tool(store, evaluator=("this-command-does-not-exist",))
    message = tool_obj.func(path="calc.table.json", runtime=_runtime())
    assert "NOT verified" in message


def test_report_lists_results_and_steers_errors_to_classics():
    store = _store_with(
        [
            {"a": 10, "t": "=SUM(A2:A3)"},
            {"a": 20, "t": "=FILTER(A2:A3, A2:A3)"},
        ]
    )
    tool_obj = create_check_table_tool(store, evaluator=_FAKE_EVALUATOR)
    message = tool_obj.func(path="calc.table.json", runtime=_runtime())
    assert message.startswith("1 ERROR — 2 formula cell(s)")
    assert "ok    t[0]: =SUM(A2:A3) -> 42" in message
    assert "ERROR t[1]" in message
    assert "FILTER is not supported" in message  # the steer toward classics


def test_expect_assertions_pass_fail_and_malformed():
    store = _store_with([{"a": 10, "t": "=SUM(A2:A2)"}])
    tool_obj = create_check_table_tool(store, evaluator=_FAKE_EVALUATOR)
    message = tool_obj.func(
        path="calc.table.json",
        runtime=_runtime(),
        expect=["t[0]=42", "t[0]=99", "a[0]=10", "not-an-assertion"],
    )
    assert "ok    expect t[0] = 42" in message
    assert "ERROR expect t[0] = 99, got 42" in message
    assert "ok    expect a[0] = 10" in message  # plain values assert too
    assert "ERROR expect 'not-an-assertion'" in message
    assert message.startswith("3 ERROR") is False  # exactly the two failures
    assert message.startswith("2 ERROR")


def _grid_store() -> InMemoryCanvasStore:
    store = InMemoryCanvasStore()
    data = {
        "columns": [{"key": "a"}],
        "rows": [{"a": 1}],
        "sheet": [{"celldata": [
            {"r": 0, "c": 0, "v": {"v": 3, "f": "=SUM(A1:A2)"}},
            {"r": 1, "c": 0, "v": {"f": "=XLOOKUP(1,B1:B2,C1:C2)"}},
        ]}],
    }
    store.write("t1", "calc.table.json", encode_table("Calc", data), "seed", actor="agent")
    return store


def test_grid_formulas_are_checked_too():
    """"They evaluate in the grid" was assumed here once — and an
    agent-written formula did not. Now the grid state is verified with the
    same engine."""
    tool_obj = create_check_table_tool(_grid_store(), evaluator=_GRID_EVALUATOR)
    message = tool_obj.func(path="calc.table.json", runtime=_runtime())
    assert "2 grid formula cell(s)" in message
    assert "ok    s0!A1: =SUM(A1:A2) -> 42" in message
    assert "ERROR s0!A2: =XLOOKUP(1,B1:B2,C1:C2) -> #ERR" in message
    assert message.startswith("1 ERROR")


def test_grid_formulas_with_a_rows_only_evaluator_say_not_verified():
    """Version skew: an old CLI ignores the sheets payload; the report says
    the grid was not verified instead of pretending it was."""
    tool_obj = create_check_table_tool(_grid_store(), evaluator=_FAKE_EVALUATOR)
    message = tool_obj.func(path="calc.table.json", runtime=_runtime())
    assert "NOT verified" in message and "grid mode" in message


# --- the real evaluator (canvas-react formula CLI) --------------------------------

_CLI = (
    Path(__file__).resolve().parents[2] / "canvas-react" / "dist" / "formula-cli.js"
)


@pytest.mark.skipif(
    not _CLI.exists() or shutil.which("node") is None,
    reason="needs Node.js and a built canvas-react (pnpm build)",
)
def test_real_cli_evaluates_like_the_canvas():
    store = _store_with(
        [
            {"a": 10, "t": 0},
            {"a": 20, "t": "=SUMIFS(A2:A3, A2:A3, \">15\")"},
        ]
    )
    tool_obj = create_check_table_tool(store, evaluator=("node", str(_CLI)))
    message = tool_obj.func(
        path="calc.table.json", runtime=_runtime(), expect=["t[1]=20"]
    )
    assert message.startswith("0 ERROR")
    assert "-> 20" in message


@pytest.mark.skipif(
    not _CLI.exists() or shutil.which("node") is None,
    reason="needs Node.js and a built canvas-react (pnpm build)",
)
def test_real_cli_smoke_contract():
    # The CLI's stdin/stdout contract, pinned directly.
    payload = json.dumps(
        {"columns": [{"key": "a"}], "rows": [{"a": "=MAX(1, 5)"}]}
    )
    proc = subprocess.run(
        ["node", str(_CLI)], input=payload.encode(), capture_output=True, timeout=60
    )
    out = json.loads(proc.stdout.decode())
    assert out["results"][0]["value"] == 5


@pytest.mark.skipif(
    not _CLI.exists() or shutil.which("node") is None,
    reason="needs Node.js and a built canvas-react (pnpm build)",
)
def test_real_cli_evaluates_the_grid_like_the_canvas():
    store = InMemoryCanvasStore()
    data = {
        "columns": [{"key": "a"}],
        "rows": [{"a": 1}],
        "sheet": [{"celldata": [
            {"r": 0, "c": 7, "v": {"v": 5}},
            {"r": 0, "c": 8, "v": {"v": 14300}},
            {"r": 0, "c": 9, "v": {"f": "=ROUND(H1*I1*2,0)"}},
            {"r": 1, "c": 9, "v": {"f": "=J1+5"}},
        ]}],
    }
    store.write("t1", "calc.table.json", encode_table("Calc", data), "seed", actor="agent")
    tool_obj = create_check_table_tool(store, evaluator=("node", str(_CLI)))
    message = tool_obj.func(path="calc.table.json", runtime=_runtime())
    assert "ok    s0!J1: =ROUND(H1*I1*2,0) -> 143000" in message
    assert "ok    s0!J2: =J1+5 -> 143005" in message
    assert message.startswith("0 ERROR")
