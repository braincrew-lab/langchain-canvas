"""The drawing layer of an ``.xlsx`` that openpyxl does not keep.

openpyxl reads charts and pictures from ``xl/drawings`` and drops the rest: text boxes,
rounded rectangles, connectors, grouped shapes, Excel 2016+ (chartex) charts and the
regular charts it cannot reach inside a group or an ``mc:Choice``. :func:`read_drawing_objects`
walks those parts itself and reports each object with its sheet, anchor cell and text.

Neither the zip nor the XML is trusted. The archive limits of
:func:`~langchain_canvas.converters.ensure_archive_within_limits` apply, a zip with odd entry
names is not read at all, and a part is skipped (never parsed) when it is oversized, holds a
NUL or a DOCTYPE/ENTITY declaration, or is not UTF-8. The stdlib pull parser is fed the
decoded text, so a declared encoding cannot smuggle a DOCTYPE past the byte check.

:func:`model_safe_text` is the one place the text of a file becomes a line a model may be shown.
"""

from __future__ import annotations

import io
import os
import posixpath
import re
import stat
import zipfile
from collections.abc import Iterator
from typing import Any, BinaryIO, Literal, NamedTuple, TypedDict, cast
from xml.etree import ElementTree

from .converters import _ensure_infos_within_limits, ensure_archive_within_limits

MAX_OBJECTS = 500
MAX_OBJECT_CHARS = 2_000
MAX_TOTAL_CHARS = 20_000
MAX_PART_BYTES = 16 * 1024 * 1024
MAX_TOTAL_PART_BYTES = 4 * MAX_PART_BYTES  # drawing bytes parsed in one read
MAX_NAME_CHARS = 80
MAX_COL, MAX_ROW, MAX_EMU = 16383, 1048575, 27_273_042_316_900  # ST_Coordinate upper bound
_MAX_GROUP_DEPTH = 32
_MAX_XML_DEPTH = 256
_CHUNK_CHARS = 16 * 1024

_XDR = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
_C = "http://schemas.openxmlformats.org/drawingml/2006/chart"
_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"
_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_PKG = "http://schemas.openxmlformats.org/package/2006/relationships"
_CHARTEX = "http://schemas.microsoft.com/office/drawing/2014/chartex"

_ANCHORS = frozenset(
    f"{{{_XDR}}}{name}" for name in ("oneCellAnchor", "twoCellAnchor", "absoluteAnchor")
)
_NV_TAGS = frozenset(
    f"{{{_XDR}}}{name}" for name in ("nvSpPr", "nvCxnSpPr", "nvGrpSpPr", "nvGraphicFramePr")
)
_NOT_READ = frozenset({f"{{{_MC}}}Fallback"})  # never read: Excel draws the Choice
_DOCTYPE = re.compile(rb"<!\s*(DOCTYPE|ENTITY)", re.IGNORECASE)
_WORKBOOK_PART = "xl/workbook.xml"


class DrawingObject(TypedDict):
    """One drawing object: where it sits and what it says."""

    sheet: int  # openpyxl worksheet index (chartsheets skipped)
    sheet_name: str
    kind: Literal["shape", "connector", "chartex", "group_chart", "choice_chart"]
    name: str  # cNvPr@name
    text: str  # a:p joined by "\n", a:t runs concatenated; "" for connectors/charts
    hidden: bool  # cNvPr@hidden in {"1", "true"} on the object or any enclosing group
    group: str | None  # enclosing grpSp name
    anchor: dict[str, Any]  # {"from": {...} | None, "to": {...} | None, "ext": {...} | None}
    cell: str  # "E2" from anchor["from"]; "" for absoluteAnchor


# --- the package ---------------------------------------------------------------------


def resolve_part_target(source_part: str, target: str, members: set[str]) -> str | None:
    """The package member a relationship ``target`` of ``source_part`` points to.

    A leading ``/`` means the package root; anything else is relative to the source
    part's directory. ``None`` when the path escapes the root, holds a backslash or NUL,
    or names no member.
    """
    if not target or "\\" in target or "\x00" in target:
        return None
    if target.startswith("/"):
        joined = target[1:]
    else:
        joined = posixpath.join(posixpath.dirname(source_part), target)
    resolved = posixpath.normpath(joined)
    if resolved == ".." or resolved.startswith("../"):
        return None
    return resolved if resolved in members else None


def _names_are_safe(infos: list[zipfile.ZipInfo]) -> bool:
    seen: set[str] = set()
    for info in infos:
        name = info.orig_filename  # ``filename`` is already cut at the first NUL
        if (
            name in seen
            or "\x00" in name
            or "\\" in name
            or ".." in name.split("/")
            or stat.S_ISLNK(info.external_attr >> 16)
        ):
            return False
        seen.add(name)
    return True


def _part_text(archive: zipfile.ZipFile, name: str) -> str | None:
    """A part's text when it is safe to parse, else None."""
    info = archive.getinfo(name)
    if info.file_size > MAX_PART_BYTES:
        return None
    raw = archive.read(info)
    if b"\x00" in raw or _DOCTYPE.search(raw):
        return None
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return None


def _finished(
    text: str, wanted: frozenset[str], skip_under: frozenset[str] = frozenset()
) -> Iterator[ElementTree.Element]:
    """Each element of a tag in ``wanted`` as soon as it ends, then dropped from the tree.

    An element inside one of the ``skip_under`` tags is not yielded. Every finished
    direct child of the root is dropped too, so what the tree holds is one chunk's worth
    of elements plus the one being built, however much the part carries. Malformed XML
    ends the stream quietly: what ended before the fault was already yielded. The
    consumer must read an element before asking for the next.
    """
    parser: ElementTree.XMLPullParser[ElementTree.Element] = ElementTree.XMLPullParser(
        events=("start", "end")
    )
    stack: list[ElementTree.Element] = []
    skipping = 0  # open elements of a skip_under tag
    too_deep = False

    def drain() -> Iterator[ElementTree.Element]:
        nonlocal skipping, too_deep
        for item in parser.read_events():
            # start and end events carry (event name, element)
            event, element = cast("tuple[str, ElementTree.Element]", item)
            if event == "start":
                stack.append(element)
                skipping += element.tag in skip_under
                if len(stack) > _MAX_XML_DEPTH:
                    too_deep = True
                    return
                continue
            stack.pop()
            skipping -= element.tag in skip_under
            is_wanted = element.tag in wanted
            if is_wanted and not skipping:
                yield element
            if stack and (is_wanted or len(stack) == 1):
                element.clear()
                del stack[-1][-1]

    try:
        for offset in range(0, len(text), _CHUNK_CHARS):
            parser.feed(text[offset : offset + _CHUNK_CHARS])
            yield from drain()
            if too_deep:
                return
        parser.close()
    except ElementTree.ParseError:
        pass
    yield from drain()


class _Relationship(NamedTuple):
    id: str
    kind: str  # last path segment of the relationship Type, e.g. "drawing"
    part: str


def _relationships(
    archive: zipfile.ZipFile, source_part: str, members: set[str]
) -> list[_Relationship]:
    """Internal relationships of ``source_part`` whose target is a package member."""
    directory, base = posixpath.split(source_part)
    rels_part = posixpath.join(directory, "_rels", f"{base}.rels")
    if rels_part not in members:
        return []
    text = _part_text(archive, rels_part)
    if text is None:
        return []
    found: list[_Relationship] = []
    for element in _finished(text, frozenset({f"{{{_PKG}}}Relationship"})):
        if (element.get("TargetMode") or "").lower() == "external":
            continue
        part = resolve_part_target(source_part, element.get("Target") or "", members)
        if part is not None:
            kind = (element.get("Type") or "").rsplit("/", 1)[-1]
            found.append(_Relationship(element.get("Id") or "", kind, part))
    return found


def _worksheets(archive: zipfile.ZipFile, members: set[str]) -> list[tuple[str, str]]:
    """``(sheet name, worksheet part)`` in workbook order; chartsheets are left out."""
    if _WORKBOOK_PART not in members:
        return []
    text = _part_text(archive, _WORKBOOK_PART)
    if text is None:
        return []
    part_by_id = {
        rel.id: rel.part
        for rel in _relationships(archive, _WORKBOOK_PART, members)
        if rel.kind == "worksheet"
    }
    sheets: list[tuple[str, str]] = []
    for element in _finished(text, frozenset({f"{{{_MAIN}}}sheet"})):
        part = part_by_id.get(element.get(f"{{{_R}}}id") or "")
        if part is not None:
            sheets.append((element.get("name") or "", part))
    return sheets


def _open(source: bytes | str | os.PathLike[str] | BinaryIO, path: str) -> zipfile.ZipFile | None:
    """The zip behind ``source`` once the archive limits pass; None when it is no zip."""
    try:
        if isinstance(source, (bytes, bytearray)):
            ensure_archive_within_limits(bytes(source), path=path)
            return zipfile.ZipFile(io.BytesIO(source))
        archive = zipfile.ZipFile(source)
    except (zipfile.BadZipFile, OSError):
        return None
    try:
        _ensure_infos_within_limits(archive.infolist(), path=path)
    except Exception:
        archive.close()
        raise
    return archive


def read_drawing_objects(
    source: bytes | str | os.PathLike[str] | BinaryIO, *, path: str = "workbook.xlsx"
) -> list[DrawingObject]:
    """Every shape, connector, chartex frame and hidden-from-openpyxl chart of a workbook.

    ``source`` is the file's bytes, a path or an open binary file. Objects come sheet by
    sheet in workbook order, then in drawing order (a group's children after its own
    anchor). Reading stops at :data:`MAX_OBJECTS` objects or once their text passes
    :data:`MAX_TOTAL_CHARS`. A source that is no zip, or whose zip holds an unsafe entry
    name, yields ``[]``; a zip over the archive limits raises
    :class:`~langchain_canvas.converters.UnsafeArchiveError`.
    """
    archive = _open(source, path)
    if archive is None:
        return []
    with archive:
        infos = archive.infolist()
        if not _names_are_safe(infos):
            return []
        members = {info.orig_filename for info in infos}
        sink = _Sink()
        drawings = _DrawingParts(archive)
        for index, (sheet_name, part) in enumerate(_worksheets(archive, members)):
            for rel in _relationships(archive, part, members):
                if rel.kind == "drawing" and rel.part.startswith("xl/drawings/"):
                    for obj in drawings.objects(rel.part):
                        if sink.full:
                            return sink.objects
                        sink.add({**obj, "sheet": index, "sheet_name": sheet_name})
                if sink.full:
                    return sink.objects
        return sink.objects


# --- the drawing part ----------------------------------------------------------------


class _Ctx(NamedTuple):
    sheet: int
    sheet_name: str
    anchor: dict[str, Any] | None = None
    cell: str = ""
    group: str | None = None
    hidden: bool = False
    in_group: bool = False
    in_choice: bool = False


class _Sink:
    """The objects read so far and the room left for more."""

    def __init__(self) -> None:
        self.objects: list[DrawingObject] = []
        self._chars = 0

    @property
    def full(self) -> bool:
        return len(self.objects) >= MAX_OBJECTS or self._chars > MAX_TOTAL_CHARS

    def add(self, obj: DrawingObject) -> None:
        self.objects.append(obj)
        self._chars += len(obj["text"])


class _DrawingParts:
    """Each drawing part parsed at most once per read, within a total byte budget.

    Many sheets may point at one drawing part and the archive limits do not count the
    repeats, so the objects of a part are kept and every sheet that references it gets
    its own copy. Once the parsed bytes would pass :data:`MAX_TOTAL_PART_BYTES`, this
    and every later new part is skipped.
    """

    def __init__(self, archive: zipfile.ZipFile) -> None:
        self._archive = archive
        self._parsed: dict[str, list[DrawingObject]] = {}
        self._bytes = 0
        self._spent = False

    def objects(self, part: str) -> list[DrawingObject]:
        if part not in self._parsed:
            size = self._archive.getinfo(part).file_size
            self._spent = self._spent or self._bytes + size > MAX_TOTAL_PART_BYTES
            self._parsed[part] = [] if self._spent else _read_drawing(self._archive, part)
            if not self._spent:
                self._bytes += size
        return self._parsed[part]


def _read_drawing(archive: zipfile.ZipFile, part: str) -> list[DrawingObject]:
    """The objects of one drawing part, with sheet 0 as a stand-in for the sheet."""
    text = _part_text(archive, part)
    sink = _Sink()
    if text is None:
        return sink.objects
    ctx = _Ctx(0, "")
    for anchor in _finished(text, _ANCHORS, _NOT_READ):
        geometry = _anchor_geometry(anchor)
        if geometry is None:
            continue
        _walk(anchor, ctx._replace(anchor=geometry, cell=_cell_label(geometry["from"])), sink, 0)
        if sink.full:
            break
    return sink.objects


def _int_attr(value: str | None, low: int, high: int) -> int:
    number = int((value or "").strip())
    if not low <= number <= high:
        raise ValueError(value)
    return number


def _marker(element: ElementTree.Element | None) -> dict[str, int] | None:
    if element is None:
        return None
    fields = {}
    limits = (("col", MAX_COL), ("row", MAX_ROW), ("colOff", MAX_EMU), ("rowOff", MAX_EMU))
    for key, limit in limits:
        child = element.find(f"{{{_XDR}}}{key}")
        fields[key] = _int_attr(child.text if child is not None else "0", 0, limit)
    return fields


def _anchor_geometry(anchor: ElementTree.Element) -> dict[str, Any] | None:
    """An anchor's ``from``/``to``/``ext``, or None when any number is out of range."""
    try:
        extent = anchor.find(f"{{{_XDR}}}ext")
        return {
            "from": _marker(anchor.find(f"{{{_XDR}}}from")),
            "to": _marker(anchor.find(f"{{{_XDR}}}to")),
            "ext": None
            if extent is None
            else {
                "cx": _int_attr(extent.get("cx"), 0, MAX_EMU),
                "cy": _int_attr(extent.get("cy"), 0, MAX_EMU),
            },
        }
    except ValueError:
        return None


def _cell_label(start: dict[str, int] | None) -> str:
    if start is None:
        return ""
    letters, column = "", start["col"] + 1
    while column > 0:
        column, rest = divmod(column - 1, 26)
        letters = chr(65 + rest) + letters
    return f"{letters}{start['row'] + 1}"


def _walk(parent: ElementTree.Element, ctx: _Ctx, sink: _Sink, depth: int) -> None:
    """The objects among ``parent``'s children, in drawing order."""
    if depth > _MAX_GROUP_DEPTH:
        return
    for child in parent:
        if sink.full:
            return
        tag = child.tag
        if tag == f"{{{_XDR}}}sp":
            _add(sink, ctx, "shape", child, _paragraphs(child))
        elif tag == f"{{{_XDR}}}cxnSp":
            _add(sink, ctx, "connector", child, "")
        elif tag == f"{{{_XDR}}}grpSp":
            name, hidden = _identity(child)
            inner = ctx._replace(group=name, hidden=ctx.hidden or hidden, in_group=True)
            _walk(child, inner, sink, depth + 1)
        elif tag == f"{{{_XDR}}}graphicFrame":
            kind = _frame_kind(child, ctx)
            if kind is not None:
                _add(sink, ctx, kind, child, "")
        elif tag == f"{{{_MC}}}AlternateContent":
            for branch in child:
                if branch.tag == f"{{{_MC}}}Choice":  # never mc:Fallback
                    _walk(branch, ctx._replace(in_choice=True), sink, depth + 1)


def _identity(element: ElementTree.Element) -> tuple[str, bool]:
    """``(name, hidden)`` from the object's ``cNvPr``."""
    for child in element:
        if child.tag in _NV_TAGS:
            props = child.find(f"{{{_XDR}}}cNvPr")
            if props is not None:
                return (props.get("name") or "")[:MAX_NAME_CHARS], props.get("hidden") in (
                    "1",
                    "true",
                )
    return "", False


def _paragraphs(shape: ElementTree.Element) -> str:
    body = shape.find(f"{{{_XDR}}}txBody")
    if body is None:
        return ""
    text_tag = f"{{{_A}}}t"
    lines = (
        "".join(run.text or "" for run in p.iter(text_tag)) for p in body.findall(f"{{{_A}}}p")
    )
    return "\n".join(lines)[:MAX_OBJECT_CHARS]


def _frame_kind(
    frame: ElementTree.Element, ctx: _Ctx
) -> Literal["chartex", "group_chart", "choice_chart"] | None:
    data = frame.find(f"{{{_A}}}graphic/{{{_A}}}graphicData")
    if data is None:
        return None
    uri = data.get("uri")
    if uri == _CHARTEX:
        return "chartex"
    if uri == _C or data.find(f"{{{_C}}}chart") is not None:
        if ctx.in_group:
            return "group_chart"
        if ctx.in_choice:
            return "choice_chart"
    return None  # a top-level regular chart is already read by openpyxl


def _add(
    sink: _Sink,
    ctx: _Ctx,
    kind: Literal["shape", "connector", "chartex", "group_chart", "choice_chart"],
    element: ElementTree.Element,
    text: str,
) -> None:
    name, hidden = _identity(element)
    sink.add({
        "sheet": ctx.sheet,
        "sheet_name": ctx.sheet_name,
        "kind": kind,
        "name": name,
        "text": text,
        "hidden": ctx.hidden or hidden,
        "group": ctx.group,
        "anchor": ctx.anchor or {"from": None, "to": None, "ext": None},
        "cell": ctx.cell,
    })


# --- text for a model ----------------------------------------------------------------

_UNSEEN = re.compile(
    "[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x84\x86-\x9f"  # C0 and C1 controls, but not \n \r \t NEL
    "‪-‮⁦-⁩"  # bidi overrides and isolates
    "​-‍⁠﻿]"  # zero-width
)
_LINE_BREAKS = re.compile(r"(?:\r\n|[\n\r  \u0085\t])+")
_FENCE = re.compile(r"(?i)<(/?)filecontext")


def model_safe_text(text: str) -> str:
    """One line of file content that a model may be shown without it reading as markup.

    In order, until the text stops changing (a stripped zero-width character must not
    leave a fence standing): invisible and control characters are dropped, every run of
    line breaks and tabs becomes `` / ``, and the ``<FileContext>`` fence tag and the
    HTML comment end ``-->`` are broken with a backslash.
    """
    while True:  # ends: each pass only removes characters or adds one-off breaks
        shown = _UNSEEN.sub("", text)
        shown = _LINE_BREAKS.sub(" / ", shown)
        shown = _FENCE.sub(r"<\\\1FileContext", shown)
        shown = shown.replace("-->", "--\\>")
        if shown == text:
            return shown
        text = shown
