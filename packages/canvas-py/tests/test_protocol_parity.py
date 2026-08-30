"""py <-> ts protocol parity gate.

The artifact data shapes are defined twice — `langchain_canvas/protocol/
artifacts.py` (what agents can emit) and `canvas-react/src/protocol/
artifacts.ts` (what the renderer reads). A field that exists on one side only
is a silent capability gap, so this test parses the TypeScript source and
compares every interface against its pydantic twin: field names in both
directions, and string-literal unions value by value.

Runs in the normal pytest step, so CI blocks any future drift.
"""

from __future__ import annotations

import re
import types
import typing
from pathlib import Path

from pydantic.alias_generators import to_camel

from langchain_canvas.protocol import artifacts as py
from langchain_canvas.protocol import events as py_events

TS_PATH = (
    Path(__file__).resolve().parents[2] / "canvas-react" / "src" / "protocol" / "artifacts.ts"
)
EVENTS_TS_PATH = TS_PATH.parent / "events.ts"

# pydantic model -> TS interface, one row per artifact-data shape on the wire.
# Every interface exported by TS_PATH (artifacts.ts) must appear here —
# test_parser_sees_every_interface enforces that.
PAIRS: list[tuple[type, str]] = [
    (py.HtmlData, "HtmlData"),
    (py.DocumentData, "DocumentData"),
    (py.FileData, "FileData"),
    (py.ChartSeries, "ChartSeries"),
    (py.ChartOptions, "ChartOptions"),
    (py.ChartData, "ChartData"),
    (py.TableColumn, "TableColumn"),
    (py.TableData, "TableData"),
    # SlidesData on the TS side is `{ html: string }` (the canonical
    # `.slides.html` deck dialect — see `client/deck.ts`), the same shape
    # as `HtmlData` — no separate pydantic class for it.
    (py.HtmlData, "SlidesData"),
    (py.Artifact, "Artifact"),
]

# pydantic model -> TS interface, one row per event shape on the wire (from
# EVENTS_TS_PATH / events.ts). Unlike PAIRS above, this is not required to
# cover every interface events.ts exports (the chat/control families are
# untouched by this contract) — only the deck-protocol events this task adds
# or changes: SlideStatus, CanvasSlidePatch, and the extended CanvasNodePatch.
EVENT_PAIRS: list[tuple[type, str]] = [
    (py_events.CanvasNodePatch, "CanvasNodePatch"),
    (py_events.SlideStatus, "SlideStatus"),
    (py_events.CanvasSlidePatch, "CanvasSlidePatch"),
]


def _ts_interfaces(ts_path: Path = TS_PATH) -> dict[str, dict[str, str]]:
    """interface name -> {field name -> type expression}, comments stripped."""
    source = ts_path.read_text()
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    source = re.sub(r"//.*", "", source)
    interfaces: dict[str, dict[str, str]] = {}
    for match in re.finditer(r"export interface (\w+)(?:<[^>]*>)?\s*\{(.*?)\n\}", source, re.S):
        fields: dict[str, str] = {}
        for field in re.finditer(r"^\s*(\w+)\??:\s*([^;]+);", match.group(2), re.M):
            fields[field.group(1)] = field.group(2).strip()
        interfaces[match.group(1)] = fields
    return interfaces


def _py_fields(model: type) -> dict[str, object]:
    """wire (camelCase) field name -> annotation."""
    return {
        info.alias or to_camel(name): info.annotation
        for name, info in model.model_fields.items()  # type: ignore[attr-defined]
    }


def _py_literals(annotation: object) -> set[str] | None:
    """The string-literal values of an annotation (unwrapping Optional), else None."""
    origin = typing.get_origin(annotation)
    if origin in (typing.Union, types.UnionType):
        args = [a for a in typing.get_args(annotation) if a is not type(None)]
        return _py_literals(args[0]) if len(args) == 1 else None
    if origin is typing.Literal:
        values = typing.get_args(annotation)
        return set(values) if all(isinstance(v, str) for v in values) else None
    return None


def _ts_literals(expression: str) -> set[str] | None:
    """The string-literal values of a TS type expression, else None."""
    if re.fullmatch(r'"[\w-]+"(\s*\|\s*"[\w-]+")*', expression.strip()):
        return set(re.findall(r'"([\w-]+)"', expression))
    return None


def test_supported_formula_functions_match_ts():
    # The formula contract is one list defined twice — the TS side is the one
    # the engine tests cover, the Python side is what tool docstrings promise.
    from langchain_canvas.formulas import SUPPORTED_FORMULA_FUNCTIONS

    ts_source = (TS_PATH.parents[1] / "io" / "formulaFunctions.ts").read_text()
    match = re.search(
        r"SUPPORTED_FORMULA_FUNCTIONS[^=]*=\s*\[(.*?)\]", ts_source, re.S
    )
    assert match, "SUPPORTED_FORMULA_FUNCTIONS not found in formulaFunctions.ts"
    ts_names = re.findall(r'"(\w+)"', match.group(1))
    assert list(SUPPORTED_FORMULA_FUNCTIONS) == ts_names


def test_asset_reference_prefixes_match_ts():
    # The asset reference contract (which relative prefixes point at canvas
    # files) is one list defined twice — py drives the export inliner, ts
    # drives display resolution and the browser export menu.
    from langchain_canvas.assets import ASSET_REFERENCE_PREFIXES

    ts_source = (TS_PATH.parents[1] / "io" / "canvasAssets.ts").read_text()
    match = re.search(r"ASSET_REFERENCE_PREFIXES\s*=\s*\[(.*?)\]", ts_source, re.S)
    assert match, "ASSET_REFERENCE_PREFIXES not found in canvasAssets.ts"
    ts_prefixes = re.findall(r'"([^"]+)"', match.group(1))
    assert list(ASSET_REFERENCE_PREFIXES) == ts_prefixes


def test_document_file_suffixes_match_ts():
    # Which files the document tools edit decides two things far apart: what
    # Python will accept, and how the browser frames a place the user pointed
    # at. A format added on one side only would frame a .docx selection as a
    # DOM element and send the agent after outer HTML that is not there.
    from langchain_canvas.document_ops import DOCUMENT_OP_SUFFIXES

    ts_source = (TS_PATH.parent / "selection.ts").read_text()
    match = re.search(r"DOCUMENT_FILE_SUFFIXES\s*=\s*\[(.*?)\]", ts_source, re.S)
    assert match, "DOCUMENT_FILE_SUFFIXES not found in selection.ts"
    assert list(DOCUMENT_OP_SUFFIXES) == re.findall(r'"([^"]+)"', match.group(1))


def test_working_copy_names_match_ts():
    # Which tab hides once a copy exists is decided from the copy's name — the
    # Python tools' rule, read again on the TS side for the tab bar.
    from langchain_canvas.replay import working_copy_path
    from langchain_canvas.tools import _deck_copy_name, _working_copy_name

    ts_source = (TS_PATH.parents[1] / "client" / "workingCopies.ts").read_text()
    marker = re.search(r'WORKING_COPY_MARKER = "([^"]+)"', ts_source)
    assert marker and _working_copy_name("sources/memo.docx") == marker.group(1) + "memo.docx"
    assert _deck_copy_name("sources/deck.pptx") == "deck.slides.html"
    assert working_copy_path("sources/book.xlsx") == "book.table.json"


def test_parser_sees_every_interface():
    # A new TS interface must get a pydantic twin and a PAIRS row.
    assert set(_ts_interfaces()) == {ts_name for _, ts_name in PAIRS}


def test_event_parser_sees_the_deck_protocol_interfaces():
    # events.ts carries the whole chat/canvas/control event family; this
    # contract only requires the deck-protocol events EVENT_PAIRS names to be
    # present and parseable — full coverage of every event is out of scope.
    event_interfaces = _ts_interfaces(EVENTS_TS_PATH)
    expected = {ts_name for _, ts_name in EVENT_PAIRS}
    missing = expected - set(event_interfaces)
    assert not missing, f"events.ts is missing interfaces: {sorted(missing)}"


def test_field_names_match_both_ways():
    interfaces = _ts_interfaces()
    event_interfaces = _ts_interfaces(EVENTS_TS_PATH)
    problems: list[str] = []
    for model, ts_name in PAIRS:
        py_names = set(_py_fields(model))
        ts_names = set(interfaces[ts_name])
        for missing in sorted(ts_names - py_names):
            problems.append(f"{ts_name}.{missing} exists in TS but not in Python")
        for missing in sorted(py_names - ts_names):
            problems.append(f"{ts_name}.{missing} exists in Python but not in TS")
    for model, ts_name in EVENT_PAIRS:
        py_names = set(_py_fields(model))
        ts_names = set(event_interfaces[ts_name])
        for missing in sorted(ts_names - py_names):
            problems.append(f"{ts_name}.{missing} exists in TS but not in Python")
        for missing in sorted(py_names - ts_names):
            problems.append(f"{ts_name}.{missing} exists in Python but not in TS")
    assert not problems, "\n".join(problems)


def test_string_literal_unions_match():
    interfaces = _ts_interfaces()
    event_interfaces = _ts_interfaces(EVENTS_TS_PATH)
    problems: list[str] = []
    for model, ts_name in PAIRS:
        ts_fields = interfaces[ts_name]
        for wire_name, annotation in _py_fields(model).items():
            if wire_name not in ts_fields:
                continue  # field-name drift is the other test's job
            py_values = _py_literals(annotation)
            ts_values = _ts_literals(ts_fields[wire_name])
            if py_values is not None and ts_values is not None and py_values != ts_values:
                problems.append(
                    f"{ts_name}.{wire_name}: py {sorted(py_values)} != ts {sorted(ts_values)}"
                )
    for model, ts_name in EVENT_PAIRS:
        ts_fields = event_interfaces[ts_name]
        for wire_name, annotation in _py_fields(model).items():
            if wire_name not in ts_fields:
                continue  # field-name drift is the other test's job
            py_values = _py_literals(annotation)
            ts_values = _ts_literals(ts_fields[wire_name])
            if py_values is not None and ts_values is not None and py_values != ts_values:
                problems.append(
                    f"{ts_name}.{wire_name}: py {sorted(py_values)} != ts {sorted(ts_values)}"
                )
    assert not problems, "\n".join(problems)
