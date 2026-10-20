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
from collections.abc import Callable, Iterator, Sequence
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
_OBJECT_TAGS = frozenset(
    [f"{{{_XDR}}}{name}" for name in ("sp", "cxnSp", "grpSp", "graphicFrame")]
    + [f"{{{_MC}}}AlternateContent"]
)
_FALLBACK = f"{{{_MC}}}Fallback"
_NOT_READ = frozenset({_FALLBACK})  # never read: Excel draws the Choice
_CHOICE = frozenset({f"{{{_MC}}}Choice"})
_DOCTYPE = re.compile(rb"<!\s*(DOCTYPE|ENTITY)", re.IGNORECASE)
_WORKBOOK_PART = "xl/workbook.xml"
_CONTENT_TYPES_PART = "[Content_Types].xml"
_CT = "http://schemas.openxmlformats.org/package/2006/content-types"
_WORKBOOK_TYPES = (  # openpyxl's order of preference
    "application/vnd.ms-excel.template.macroEnabled.main+xml",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml",
    "application/vnd.ms-excel.sheet.macroEnabled.main+xml",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
)


class DrawingObject(TypedDict):
    """One drawing object: where it sits and what it says."""

    sheet: int  # the sheet's place in the reader's sheet list (see the read functions)
    sheet_name: str
    kind: Literal["shape", "connector", "chartex", "group_chart", "choice_chart"]
    name: str  # cNvPr@name
    text: str  # a:p joined by "\n", a:t runs concatenated; "" for connectors/charts
    hidden: bool  # cNvPr@hidden in {"1", "true"} on the object or any enclosing group
    group: str | None  # enclosing grpSp name
    anchor: dict[str, Any]  # {"from": {...} | None, "to": {...} | None, "ext": {...} | None}
    cell: str  # "E2": the cell the object's top-left sits in; "" for absoluteAnchor


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
    text: str,
    wanted: frozenset[str],
    skip_under: frozenset[str] = frozenset(),
    mark_under: frozenset[str] = frozenset(),
) -> Iterator[tuple[ElementTree.Element, bool]]:
    """Each element of a tag in ``wanted`` as soon as it ends, then dropped from the tree.

    Each comes with whether it sits inside one of the ``mark_under`` tags: the ancestry
    is gone once the element is dropped. An element inside one of the ``skip_under`` tags
    is not yielded. Every finished direct child of the root is dropped too, so what the
    tree holds is one chunk's worth
    of elements plus the one being built, however much the part carries. Malformed XML
    ends the stream quietly: what ended before the fault was already yielded. The
    consumer must read an element before asking for the next.
    """
    parser: ElementTree.XMLPullParser[ElementTree.Element] = ElementTree.XMLPullParser(
        events=("start", "end")
    )
    stack: list[ElementTree.Element] = []
    skipping = 0  # open elements of a skip_under tag
    marked = 0  # open elements of a mark_under tag
    too_deep = False

    def drain() -> Iterator[tuple[ElementTree.Element, bool]]:
        nonlocal skipping, marked, too_deep
        for item in parser.read_events():
            # start and end events carry (event name, element)
            event, element = cast("tuple[str, ElementTree.Element]", item)
            if event == "start":
                stack.append(element)
                skipping += element.tag in skip_under
                marked += element.tag in mark_under
                if len(stack) > _MAX_XML_DEPTH:
                    too_deep = True
                    return
                continue
            stack.pop()
            skipping -= element.tag in skip_under
            marked -= element.tag in mark_under
            is_wanted = element.tag in wanted
            if is_wanted and not skipping:
                yield element, marked > 0
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
    type: str = ""  # the whole relationship Type


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
    for element, _ in _finished(text, frozenset({f"{{{_PKG}}}Relationship"})):
        if (element.get("TargetMode") or "").lower() == "external":
            continue
        part = resolve_part_target(source_part, element.get("Target") or "", members)
        if part is not None:
            rel_type = element.get("Type") or ""
            kind = rel_type.rsplit("/", 1)[-1]
            found.append(_Relationship(element.get("Id") or "", kind, part, rel_type))
    return found


def _workbook_part(archive: zipfile.ZipFile, members: set[str]) -> str:
    """The workbook part, found the way openpyxl finds it.

    It is the ``[Content_Types].xml`` override whose type is one of the four workbook
    types (template macro, template, macro, plain: the first that is present wins), else
    ``xl/workbook.xml``, which is also the answer when the types part cannot be read.
    """
    text = _part_text(archive, _CONTENT_TYPES_PART) if _CONTENT_TYPES_PART in members else None
    if text is None:
        return _WORKBOOK_PART
    wanted = frozenset({f"{{{_CT}}}Override", "Override"})
    parts: dict[str, str] = {}
    for element, _ in _finished(text, wanted):
        content_type = element.get("ContentType") or ""
        if content_type in _WORKBOOK_TYPES:
            parts.setdefault(content_type, element.get("PartName") or "")
    for content_type in _WORKBOOK_TYPES:
        if content_type in parts:
            return parts[content_type].removeprefix("/")
    return _WORKBOOK_PART


def _worksheets(archive: zipfile.ZipFile, members: set[str]) -> list[tuple[str, str]]:
    """``(sheet name, sheet part)`` in the order openpyxl numbers the worksheets of a
    package laid out the usual way.

    Like openpyxl, a sheet without ``r:id`` or whose part is not in the archive is
    skipped, and a chartsheet takes no number. A dialog sheet or a macro sheet is a
    worksheet to openpyxl, so it takes one. A hand-made package can still be numbered
    differently (openpyxl does not normalise an absolute target, for one); a caller that
    needs openpyxl's own numbers passes the drawings openpyxl found to
    :func:`read_sheet_drawings_checked`.
    """
    workbook = _workbook_part(archive, members)
    if workbook not in members:
        return []
    text = _part_text(archive, workbook)
    if text is None:
        return []
    part_by_id = {
        rel.id: rel.part
        for rel in _relationships(archive, workbook, members)
        if "chartsheet" not in rel.type
    }
    sheets: list[tuple[str, str]] = []
    for element, _ in _finished(text, frozenset({f"{{{_MAIN}}}sheet"})):
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

    :func:`read_drawing_objects_checked` also says whether a limit cut the read short.
    """
    return read_drawing_objects_checked(source, path=path)[0]


def read_drawing_objects_checked(
    source: bytes | str | os.PathLike[str] | BinaryIO, *, path: str = "workbook.xlsx"
) -> tuple[list[DrawingObject], bool]:
    """:func:`read_drawing_objects` plus whether the read was complete.

    The flag is False when a limit left drawing content unread: the object or text cap
    of a drawing, of a worksheet or of the whole read, or a part skipped because the
    byte budget was spent. Objects after the cut are missing from the list, so a caller
    that must know every object of a kind was seen (every chart, say) cannot rely on it.
    An object's ``sheet`` is its worksheet's place in the order :func:`_worksheets` gives.
    """

    def sheets(archive: zipfile.ZipFile, members: set[str], parts: _Parts) -> _SheetObjects:
        for sheet_name, part in _worksheets(archive, members):
            yield sheet_name, parts.sheet_objects(part)

    return _collect(source, path, sheets)


def read_sheet_drawings_checked(
    source: bytes | str | os.PathLike[str] | BinaryIO,
    sheets: Sequence[tuple[str, Sequence[str]]],
    *,
    path: str = "workbook.xlsx",
) -> tuple[list[DrawingObject], bool]:
    """The objects of the drawings each sheet shows, as the caller found them.

    ``sheets`` holds, in the caller's sheet order, each sheet's name and the package
    members of its drawings. An object's ``sheet`` is its sheet's place in that list, so
    a caller that lists what openpyxl resolved for each worksheet it loaded gets
    openpyxl's numbers however the package is put together. The limits and the flag are
    those of :func:`read_drawing_objects_checked`; a listed part the archive does not
    hold also leaves the read incomplete.
    """

    def listed(_archive: zipfile.ZipFile, members: set[str], parts: _Parts) -> _SheetObjects:
        for sheet_name, drawing_parts in sheets:
            present = [part for part in drawing_parts if part in members]
            parts.incomplete |= len(present) < len(drawing_parts)
            yield sheet_name, parts.drawing_objects(present)

    return _collect(source, path, listed)


_SheetObjects = Iterator[tuple[str, list[DrawingObject]]]


def _collect(
    source: bytes | str | os.PathLike[str] | BinaryIO,
    path: str,
    sheets: Callable[[zipfile.ZipFile, set[str], _Parts], _SheetObjects],
) -> tuple[list[DrawingObject], bool]:
    """The objects ``sheets`` yields, sheet by sheet within the caps, and whether all were read."""
    archive = _open(source, path)
    if archive is None:
        return [], True
    with archive:
        infos = archive.infolist()
        if not _names_are_safe(infos):
            return [], True
        members = {info.orig_filename for info in infos}
        sink = _Sink()
        parts = _Parts(archive, members)
        for index, (sheet_name, objects) in enumerate(sheets(archive, members, parts)):
            for obj in objects:
                if sink.full:
                    return sink.objects, False
                sink.add({**obj, "sheet": index, "sheet_name": sheet_name})
        return sink.objects, not parts.incomplete


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
    # Inside a group: child coordinates -> EMU from the anchor's top-left, as
    # (scale_x, scale_y, shift_x, shift_y), and the outermost group's size in EMU.
    frame: tuple[float, float, float, float] | None = None
    span: tuple[int, int] | None = None


class _Sink:
    """The objects read so far and the room left for more."""

    def __init__(self) -> None:
        self.objects: list[DrawingObject] = []
        self.truncated = False  # an object was left unread because the sink was full
        self._chars = 0

    @property
    def full(self) -> bool:
        return len(self.objects) >= MAX_OBJECTS or self._chars > MAX_TOTAL_CHARS

    def add(self, obj: DrawingObject) -> None:
        self.objects.append(obj)
        self._chars += len(obj["text"])


class _Parts:
    """Each worksheet's drawing objects, read at most once per read, within a byte budget.

    Many sheet entries may name one worksheet part, and many worksheets one drawing part;
    the archive limits do not count the repeats. So the objects of a worksheet and of a
    drawing are kept, and every sheet that names them gets its own copy. The relationships
    part of a worksheet and each drawing part count against :data:`MAX_TOTAL_PART_BYTES`
    when first parsed; once the next one would pass it, that part and every later new part
    is skipped. ``incomplete`` turns True when any of these limits left content unread.
    """

    def __init__(self, archive: zipfile.ZipFile, members: set[str]) -> None:
        self._archive = archive
        self._members = members
        self._drawings: dict[str, list[DrawingObject]] = {}
        self._sheets: dict[str, list[DrawingObject]] = {}
        self._left = MAX_TOTAL_PART_BYTES
        self._spent = False
        self.incomplete = False

    def _admit(self, part: str) -> bool:
        """Whether ``part`` fits what is left of the budget; it is then spent."""
        size = self._archive.getinfo(part).file_size
        self._spent = self._spent or size > self._left
        if not self._spent:
            self._left -= size
        return not self._spent

    def sheet_objects(self, sheet_part: str) -> list[DrawingObject]:
        """The objects of every drawing a worksheet part points at, at most :data:`MAX_OBJECTS`."""
        if sheet_part not in self._sheets:
            self._sheets[sheet_part] = self.drawing_objects(self._drawing_parts(sheet_part))
        return self._sheets[sheet_part]

    def drawing_objects(self, drawing_parts: list[str]) -> list[DrawingObject]:
        """The objects of these drawing parts in order, at most :data:`MAX_OBJECTS`."""
        found: list[DrawingObject] = []
        for part in drawing_parts:
            objects = self._drawing(part)
            if len(found) >= MAX_OBJECTS:  # full: only one more object is a loss
                self.incomplete |= bool(objects)
                continue
            found.extend(objects)
            self.incomplete |= len(found) > MAX_OBJECTS
        return found[:MAX_OBJECTS]

    def _drawing_parts(self, sheet_part: str) -> list[str]:
        directory, base = posixpath.split(sheet_part)
        rels_part = posixpath.join(directory, "_rels", f"{base}.rels")
        if rels_part not in self._members:
            return []
        if not self._admit(rels_part):
            self.incomplete = True
            return []
        return [
            rel.part
            for rel in _relationships(self._archive, sheet_part, self._members)
            if rel.kind == "drawing" and rel.part.startswith("xl/drawings/")
        ]

    def _drawing(self, part: str) -> list[DrawingObject]:
        if part not in self._drawings:
            if self._admit(part):
                self._drawings[part], truncated = _read_drawing(self._archive, part)
                self.incomplete |= truncated
            else:
                self._drawings[part] = []
                self.incomplete = True
        return self._drawings[part]


def _read_drawing(archive: zipfile.ZipFile, part: str) -> tuple[list[DrawingObject], bool]:
    """The objects of one drawing part, with sheet 0 as a stand-in for the sheet.

    The flag is True when a cap left objects of the part unread.
    """
    text = _part_text(archive, part)
    sink = _Sink()
    if text is None:
        return sink.objects, False
    ctx = _Ctx(0, "")
    for anchor, in_choice in _finished(text, _ANCHORS, _NOT_READ, _CHOICE):
        if sink.full:  # only an anchor that holds an object is a loss
            sink.truncated |= any(child.tag in _OBJECT_TAGS for child in anchor)
            continue
        geometry = _anchor_geometry(anchor)
        if geometry is None:
            continue
        # an anchor wrapped in mc:Choice is a chart openpyxl cannot read, like one inside it
        anchored = ctx._replace(
            anchor=geometry, cell=_cell_label(geometry["from"]), in_choice=in_choice
        )
        _walk(anchor, anchored, sink, 0)
    return sink.objects, sink.truncated


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
    children = list(parent)
    for at, child in enumerate(children):
        tag = child.tag
        if sink.full:  # a picture is never read, so only a later object is lost
            sink.truncated |= any(later.tag in _OBJECT_TAGS for later in children[at:])
            return
        if tag == f"{{{_XDR}}}sp":
            _add(sink, ctx, "shape", child, _paragraphs(child))
        elif tag == f"{{{_XDR}}}cxnSp":
            _add(sink, ctx, "connector", child, "")
        elif tag == f"{{{_XDR}}}grpSp":
            name, hidden = _identity(child)
            inner = ctx._replace(group=name, hidden=ctx.hidden or hidden, in_group=True)
            _walk(child, _enter_group(child, inner), sink, depth + 1)
        elif tag == f"{{{_XDR}}}graphicFrame":
            kind = _frame_kind(child, ctx)
            if kind is not None:
                _add(sink, ctx, kind, child, "")
        elif tag == f"{{{_MC}}}AlternateContent":
            for branch in child:
                if branch.tag == f"{{{_MC}}}Choice":  # never mc:Fallback
                    _walk(branch, ctx._replace(in_choice=True), sink, depth + 1)


def _xfrm(element: ElementTree.Element) -> dict[str, int] | None:
    """An object's ``a:xfrm`` numbers (``x y cx cy`` and, on a group, ``chx chy chcx chcy``).

    None when the object has no transform or a number is missing or out of range.
    """
    holder = element.find(f"{{{_XDR}}}grpSpPr")
    if holder is None:
        holder = element.find(f"{{{_XDR}}}spPr")
    xfrm = (
        element.find(f"{{{_XDR}}}xfrm")  # a graphicFrame keeps its own
        if holder is None
        else holder.find(f"{{{_A}}}xfrm")
    )
    if xfrm is None:
        return None
    numbers: dict[str, int] = {}
    fields = (("off", "", True), ("ext", "", False), ("chOff", "ch", True), ("chExt", "ch", False))
    try:
        for tag, prefix, is_offset in fields:
            part = xfrm.find(f"{{{_A}}}{tag}")
            if part is None:
                if prefix:  # only a group has a child space
                    continue
                return None
            keys, low = (("x", "y"), -MAX_EMU) if is_offset else (("cx", "cy"), 0)
            for key in keys:
                numbers[prefix + key] = _int_attr(part.get(key), low, MAX_EMU)
    except ValueError:
        return None
    return numbers


def _enter_group(group: ElementTree.Element, ctx: _Ctx) -> _Ctx:
    """``ctx`` for a group's children: where their coordinates land in the anchor.

    A group draws its child space (``chOff``/``chExt``) into its own box (``off``/``ext``);
    the outermost group's box is the anchor's, so its top-left is the anchor's top-left.
    A group without usable numbers leaves its children at the group's cell.
    """
    numbers = _xfrm(group)
    if numbers is None or "chcx" not in numbers:
        return ctx._replace(frame=None, span=None)
    if ctx.frame is None:
        if ctx.span is not None:  # an enclosing group had no usable numbers
            return ctx
        parent, span = (1.0, 1.0, -numbers["x"], -numbers["y"]), (numbers["cx"], numbers["cy"])
    else:
        parent, span = ctx.frame, ctx.span
    sx = numbers["cx"] / numbers["chcx"] if numbers["chcx"] else 1.0
    sy = numbers["cy"] / numbers["chcy"] if numbers["chcy"] else 1.0
    px, py, tx, ty = parent
    frame = (
        sx * px,
        sy * py,
        (numbers["x"] - numbers["chx"] * sx) * px + tx,
        (numbers["y"] - numbers["chy"] * sy) * py + ty,
    )
    return ctx._replace(frame=frame, span=span)


def _spread(start: int, start_off: int, end: int, end_off: int, size: int, at: float) -> int:
    """The column (or row) ``at`` EMU past the anchor's start falls in.

    Only the anchor's two corners are known, so the columns between them are taken to be
    of equal width; a box of equal columns (an approval box) is labelled exactly.
    """
    if end <= start:
        return start
    width = (size + start_off - end_off) / (end - start)
    if width <= 0:
        return start
    return min(end, start + int((start_off + min(max(at, 0.0), size)) // width))


def _member_cell(element: ElementTree.Element, ctx: _Ctx) -> str:
    """The cell a grouped object's top-left sits in, else its group's cell."""
    anchor = ctx.anchor or {}
    start, end = anchor.get("from"), anchor.get("to")
    numbers = _xfrm(element)
    if ctx.frame is None or ctx.span is None or start is None or end is None or numbers is None:
        return ctx.cell
    sx, sy, tx, ty = ctx.frame
    column = _spread(start["col"], start["colOff"], end["col"], end["colOff"], ctx.span[0],
                     numbers["x"] * sx + tx)
    row = _spread(start["row"], start["rowOff"], end["row"], end["rowOff"], ctx.span[1],
                  numbers["y"] * sy + ty)
    return _cell_label({"col": column, "row": row})


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
    lines = ("".join(_runs(p)) for p in body.findall(f"{{{_A}}}p"))
    return "\n".join(lines)[:MAX_OBJECT_CHARS]


def _runs(element: ElementTree.Element) -> Iterator[str]:
    """The ``a:t`` text under ``element`` in order, skipping every ``mc:Fallback``."""
    for child in element:
        if child.tag == f"{{{_A}}}t":
            yield child.text or ""
        elif child.tag != _FALLBACK:
            yield from _runs(child)


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
        "cell": _member_cell(element, ctx) if ctx.in_group else ctx.cell,
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
