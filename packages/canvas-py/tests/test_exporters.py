"""Exporter contract: table -> xlsx, html -> docx, routing, the export tool.

Round-trips are asserted with the real readers (openpyxl / python-docx), so
"exported" means a mainstream library opens the file and finds the content.
"""

from __future__ import annotations

import io
import json
from dataclasses import dataclass, field
from typing import Any

from docx import Document
from openpyxl import load_workbook

from langchain_canvas import InMemoryCanvasStore, create_export_tool
from langchain_canvas.exporters import (
    HtmlDocxExporter,
    TableXlsxExporter,
    default_exporters,
    exporter_for,
)

# --- routing ---------------------------------------------------------------------


def test_exporter_routing_matches_suffix_and_target():
    exporters = default_exporters()
    assert isinstance(exporter_for("sales.table.json", "xlsx", exporters), TableXlsxExporter)
    assert isinstance(exporter_for("report/01-a.html", "docx", exporters), HtmlDocxExporter)
    assert exporter_for("sales.table.json", "docx", exporters) is None
    assert exporter_for("photo.png", "docx", exporters) is None


# --- table -> xlsx ---------------------------------------------------------------


def test_table_columns_rows_export_round_trip():
    content = json.dumps(
        {
            "type": "table",
            "title": "Sales",
            "data": {
                "columns": [
                    {"key": "region", "label": "Region"},
                    {"key": "total", "label": "Total"},
                ],
                "rows": [
                    {"region": "East", "total": 10},
                    {"region": "West", "total": 20},
                ],
            },
        }
    )
    result = TableXlsxExporter().export(content, path="sales.table.json")
    assert result.filename == "sales.xlsx"

    sheet = load_workbook(io.BytesIO(result.data)).worksheets[0]
    assert [cell.value for cell in sheet[1]] == ["Region", "Total"]
    assert sheet[1][0].font.bold
    assert sheet.cell(row=2, column=1).value == "East"
    assert sheet.cell(row=3, column=2).value == 20


def test_table_fortune_sheet_export_values_and_merges():
    content = json.dumps(
        {
            "type": "table",
            "data": {
                "sheet": [
                    {
                        "name": "Q1",
                        "celldata": [
                            {"r": 0, "c": 0, "v": {"v": "Head", "bl": 1}},
                            {"r": 1, "c": 1, "v": 42},
                        ],
                        "config": {"merge": {"0_0": {"r": 0, "c": 0, "rs": 1, "cs": 2}}},
                    }
                ]
            },
        }
    )
    result = TableXlsxExporter().export(content, path="q1.table.json")
    sheet = load_workbook(io.BytesIO(result.data))["Q1"]
    assert sheet.cell(row=1, column=1).value == "Head"
    assert sheet.cell(row=2, column=2).value == 42
    assert [str(r) for r in sheet.merged_cells.ranges] == ["A1:B1"]


def test_table_formula_rows_stay_formulas():
    # An "="-prefixed row value must land as a live formula, not a frozen string.
    content = json.dumps(
        {
            "type": "table",
            "data": {
                "columns": [{"key": "a", "label": "A"}],
                "rows": [{"a": 10}, {"a": 20}, {"a": "=SUM(A2:A3)"}],
            },
        }
    )
    result = TableXlsxExporter().export(content, path="sums.table.json")
    sheet = load_workbook(io.BytesIO(result.data)).worksheets[0]
    cell = sheet.cell(row=4, column=1)
    assert cell.value == "=SUM(A2:A3)"
    assert cell.data_type == "f"  # stored as a formula, recalculated on open


def test_table_fortune_sheet_typed_formula_stays_a_formula():
    # A grid-typed formula carries `f` next to the cached `v` — export the
    # formula (openpyxl stores no cached value; apps recalculate on open).
    content = json.dumps(
        {
            "type": "table",
            "data": {
                "sheet": [
                    {
                        "name": "S",
                        "celldata": [
                            {"r": 0, "c": 0, "v": {"v": 1}},
                            {"r": 1, "c": 0, "v": {"v": 2}},
                            {"r": 2, "c": 0, "v": {"v": 3, "f": "=SUM(A1:A2)"}},
                        ],
                    }
                ]
            },
        }
    )
    result = TableXlsxExporter().export(content, path="s.table.json")
    sheet = load_workbook(io.BytesIO(result.data))["S"]
    cell = sheet.cell(row=3, column=1)
    assert cell.value == "=SUM(A1:A2)"
    assert cell.data_type == "f"


# --- html -> docx ----------------------------------------------------------------

_PNG_1PX = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
    "AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)

_HTML = f"""<html><head><title>t</title><style>body {{ font: 16px serif; }}</style></head>
<body>
<div class="kicker">REPORT · SECTION 02</div>
<h1>핵심 API 기능</h1>
<p>The store keeps <strong>every</strong> file and its <em>history</em>.</p>
<ul><li>read</li><li>write</li></ul>
<table><tr><th>Tool</th><th>Role</th></tr><tr><td>read_canvas</td><td>read</td></tr></table>
<img src="data:image/png;base64,{_PNG_1PX}"/>
<hr/>
<p>After the break.</p>
</body></html>"""


def test_html_docx_export_structure():
    result = HtmlDocxExporter().export(_HTML, path="report/02-features.html")
    assert result.filename == "02-features.docx"

    document = Document(io.BytesIO(result.data))
    texts = [p.text for p in document.paragraphs if p.text.strip()]
    assert "REPORT · SECTION 02" in texts  # kicker div survives as a paragraph
    assert "After the break." in texts
    assert "font: 16px" not in " ".join(texts)  # style content dropped

    heading = next(p for p in document.paragraphs if p.text == "핵심 API 기능")
    assert heading.style.name == "Heading 1"

    prose = next(p for p in document.paragraphs if "every" in p.text)
    assert any(run.bold for run in prose.runs)
    assert any(run.italic for run in prose.runs)

    bullets = [p.text for p in document.paragraphs if p.style.name == "List Bullet"]
    assert bullets == ["read", "write"]

    table = document.tables[0]
    assert table.cell(0, 0).text == "Tool"
    assert table.cell(0, 0).paragraphs[0].runs[0].bold  # th row bolded
    assert table.cell(1, 1).text == "read"

    assert len(document.inline_shapes) == 1  # the data: URI image
    assert 'type="page"' in document.element.xml  # hr became a page break


def test_html_docx_title_names_the_file():
    result = HtmlDocxExporter().export("<p>hi</p>", path="report/", title="My Report")
    assert result.filename == "My-Report.docx"


# --- the export tool -------------------------------------------------------------


@dataclass
class _Runtime:
    context: Any = None
    config: dict[str, Any] = field(default_factory=dict)


def _runtime(thread_id: str = "t1") -> _Runtime:
    return _Runtime(config={"configurable": {"thread_id": thread_id}})


def test_export_tool_writes_under_exports():
    store = InMemoryCanvasStore()
    store.write("t1", "page.html", "<h1>One</h1><p>Body</p>", "seed", actor="agent")
    tool_obj = create_export_tool(store)

    message = tool_obj.func(path="page.html", target="docx", runtime=_runtime())
    assert "exports/page.docx" in message

    exported = store.read_bytes("t1", "exports/page.docx")
    document = Document(io.BytesIO(exported.data))
    assert any(p.text == "One" for p in document.paragraphs)


def test_export_tool_merges_a_directory_in_name_order():
    store = InMemoryCanvasStore()
    store.write("t1", "report/02-b.html", "<h1>Second</h1>", "seed", actor="agent")
    store.write("t1", "report/01-a.html", "<h1>First</h1>", "seed", actor="agent")
    store.write("t1", "report/notes.txt", "not html", "seed", actor="agent")
    tool_obj = create_export_tool(store)

    message = tool_obj.func(path="report/", target="docx", runtime=_runtime())
    assert "exports/report.docx" in message

    document = Document(io.BytesIO(store.read_bytes("t1", "exports/report.docx").data))
    texts = [p.text for p in document.paragraphs if p.text.strip()]
    assert texts.index("First") < texts.index("Second")
    assert 'type="page"' in document.element.xml  # sections split by page break


def test_export_tool_is_honest_about_misses():
    store = InMemoryCanvasStore()
    store.write("t1", "sales.table.json", json.dumps({"data": {}}), "seed", actor="agent")
    tool_obj = create_export_tool(store)

    missing = tool_obj.func(path="nope.html", target="docx", runtime=_runtime())
    assert missing.startswith("Error:")

    wrong_target = tool_obj.func(path="sales.table.json", target="docx", runtime=_runtime())
    assert wrong_target.startswith("Error:")
    assert "xlsx" in wrong_target  # names the formats that would work

    empty_dir = tool_obj.func(path="deck/", target="docx", runtime=_runtime())
    assert empty_dir.startswith("Error:")
