"""Source converters — stored source files rendered as model-usable content.

Uploaded files land in the store under ``sources/`` (the user's original
material, read-only for agents). A :class:`SourceConverter` turns one such
file's raw bytes into a :class:`ConvertedSource`: a list of LangChain-standard
content blocks (``{"type": "text", ...}`` and, for vision formats,
``{"type": "image", ...}``) plus metadata. The standard ``read_canvas`` tool
routes binary files through the converter matching their suffix, so the agent
never parses bytes.

Converters are pluggable: pass your own list to ``create_canvas_tools`` to
replace or extend the defaults — an in-house OCR or document-AI pipeline
implements the same one-method contract. Built-in converters that need a
parser library import it lazily and raise
:class:`MissingConverterDependencyError` with an install hint when absent, so
the core package stays dependency-free.
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable


@dataclass(frozen=True)
class ConvertedSource:
    """A source file in model-usable form.

    ``blocks`` are LangChain-standard content blocks — text blocks always,
    image blocks for vision formats. ``metadata`` carries format facts a tool
    may surface to the agent (sheet names, page count, detected encoding, ...).
    """

    blocks: list[dict[str, Any]]
    metadata: dict[str, Any] = field(default_factory=dict)


@runtime_checkable
class SourceConverter(Protocol):
    """The pluggable contract: bytes of one source file in, blocks out."""

    suffixes: tuple[str, ...]
    """Path suffixes this converter handles (lowercase, with the dot)."""

    def convert(self, data: bytes, *, path: str) -> ConvertedSource:
        """Convert one file. ``path`` is the store path, for messages/metadata."""
        ...


class MissingConverterDependencyError(RuntimeError):
    """A built-in converter's parser library is not installed.

    The message names the missing package and the extra that installs it, so
    the standard tools can relay an honest, actionable error to the agent.
    """


def converter_for(path: str, converters: list[SourceConverter]) -> SourceConverter | None:
    """The first converter whose suffix matches ``path`` (case-insensitive)."""
    lowered = path.lower()
    for converter in converters:
        if lowered.endswith(converter.suffixes):
            return converter
    return None


class TextSourceConverter:
    """Plain-text formats, decoded with UTF-8 (BOM-aware) then CP949.

    The trivial reference implementation of the contract. Files that decode
    with neither encoding fall back to lossy UTF-8 and say so in metadata —
    the agent gets honest content instead of an opaque failure.
    """

    suffixes: tuple[str, ...] = (".txt", ".md", ".markdown", ".csv", ".json", ".html", ".htm")

    def convert(self, data: bytes, *, path: str) -> ConvertedSource:
        for encoding in ("utf-8-sig", "cp949"):
            try:
                return ConvertedSource(
                    blocks=[{"type": "text", "text": data.decode(encoding)}],
                    metadata={"encoding": encoding},
                )
            except UnicodeDecodeError:
                continue
        return ConvertedSource(
            blocks=[{"type": "text", "text": data.decode("utf-8", errors="replace")}],
            metadata={"encoding": "unknown (lossy utf-8)"},
        )


class XlsxSourceConverter:
    """Excel workbooks, one CSV-shaped section per sheet.

    Reads cached values (what Excel last computed), so formula cells show
    their results. Requires ``openpyxl`` — installed by the ``xlsx`` extra.
    """

    suffixes: tuple[str, ...] = (".xlsx",)

    def convert(self, data: bytes, *, path: str) -> ConvertedSource:
        try:
            from openpyxl import load_workbook  # type: ignore[import-untyped]
        except ImportError as exc:
            raise MissingConverterDependencyError(
                "reading .xlsx needs openpyxl — install langchain-canvas[xlsx] "
                "or register your own converter for .xlsx"
            ) from exc

        workbook = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        sections: list[str] = []
        sheet_names: list[str] = []
        for sheet in workbook.worksheets:
            sheet_names.append(sheet.title)
            out = io.StringIO()
            writer = csv.writer(out)
            for row in sheet.iter_rows(values_only=True):
                writer.writerow(["" if cell is None else str(cell) for cell in row])
            body = out.getvalue().rstrip("\n") or "(empty)"
            sections.append(f"### sheet: {sheet.title}\n{body}")
        workbook.close()
        return ConvertedSource(
            blocks=[{"type": "text", "text": "\n\n".join(sections)}],
            metadata={"sheets": ", ".join(sheet_names), "values": "cached results"},
        )


def default_converters() -> list[SourceConverter]:
    """The built-in converter set. Grows as format tiers land."""
    return [TextSourceConverter(), XlsxSourceConverter()]
