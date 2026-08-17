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

TS_PATH = (
    Path(__file__).resolve().parents[2] / "canvas-react" / "src" / "protocol" / "artifacts.ts"
)

# pydantic model -> TS interface, one row per shape on the wire.
PAIRS: list[tuple[type, str]] = [
    (py.HtmlData, "HtmlData"),
    (py.DocumentData, "DocumentData"),
    (py.ChartSeries, "ChartSeries"),
    (py.ChartOptions, "ChartOptions"),
    (py.ChartData, "ChartData"),
    (py.TableColumn, "TableColumn"),
    (py.TableData, "TableData"),
    (py.SlideElement, "SlideElement"),
    (py.Slide, "Slide"),
    (py.SlidesData, "SlidesData"),
    (py.Artifact, "Artifact"),
]


def _ts_interfaces() -> dict[str, dict[str, str]]:
    """interface name -> {field name -> type expression}, comments stripped."""
    source = TS_PATH.read_text()
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


def test_parser_sees_every_interface():
    # A new TS interface must get a pydantic twin and a PAIRS row.
    assert set(_ts_interfaces()) == {ts_name for _, ts_name in PAIRS}


def test_field_names_match_both_ways():
    interfaces = _ts_interfaces()
    problems: list[str] = []
    for model, ts_name in PAIRS:
        py_names = set(_py_fields(model))
        ts_names = set(interfaces[ts_name])
        for missing in sorted(ts_names - py_names):
            problems.append(f"{ts_name}.{missing} exists in TS but not in Python")
        for missing in sorted(py_names - ts_names):
            problems.append(f"{ts_name}.{missing} exists in Python but not in TS")
    assert not problems, "\n".join(problems)


def test_string_literal_unions_match():
    interfaces = _ts_interfaces()
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
    assert not problems, "\n".join(problems)
