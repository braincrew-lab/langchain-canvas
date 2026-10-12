"""What a read-only workbook needs on top of the editable reader to look like Excel.

``xlsx_sheets_and_charts(data, read_only=True)`` calls :func:`apply_read_only_fidelity`
once per sheet. Everything here is display state for a grid that is looked at,
not typed into, so values Excel derives from a format (the text and colour a
number-format section gives, see :func:`format_number_sections`) are written
into the cell as they stand in the file.

Fortune already has a place for most of it: ``hide`` and ``color`` on the sheet,
``config.rowhidden``/``colhidden``, ``hyperlink``, and ``cl`` (strike), ``rt``
(rotation, the same 0-180 encoding Excel uses), ``tr`` and ``ps`` (note) on the
cell. What Fortune cannot draw on its own — patterned and gradient fills,
indent, the list-validation arrow, data bars and icons — travels in one cell key,
``lcx``, that the canvas grid paints (``sheetPaint.ts``).
"""

from __future__ import annotations

import math
import re
from typing import Any

from .xlsx_import import INDEXED_PALETTE, _format_number, _js_number, _to_hex

#: Excel's eight named format colours.
_NAMED_COLOURS = {
    "black": "#000000", "blue": "#0000FF", "cyan": "#00FFFF", "green": "#00FF00",
    "magenta": "#FF00FF", "red": "#FF0000", "white": "#FFFFFF", "yellow": "#FFFF00",
}
_CONDITION = re.compile(r"^\[(<=|>=|<>|<|>|=)\s*(-?\d+(?:\.\d+)?)\]")
_BRACKET = re.compile(r"\[[^\]]*\]")
_DATE_TOKEN = re.compile(r"[ymdhs]", re.I)
_DIGITS = set("0#?,.%")

#: How much of a cell a pattern's ink covers — for the blended fallback colour a
#: grid without the painter shows.
_PATTERN_INK = {
    "gray0625": 0.0625, "gray125": 0.125, "lightGray": 0.25, "mediumGray": 0.5,
    "darkGray": 0.75, "lightHorizontal": 0.25, "lightVertical": 0.25, "lightDown": 0.25,
    "lightUp": 0.25, "lightGrid": 0.4, "lightTrellis": 0.3, "darkHorizontal": 0.5,
    "darkVertical": 0.5, "darkDown": 0.5, "darkUp": 0.5, "darkGrid": 0.6, "darkTrellis": 0.7,
}
_SAFE_LINK = re.compile(r"^(https?://|mailto:)", re.I)
#: Upper bound on cells one validation range marks — a whole-column rule on a
#: million-row sheet would otherwise inflate the payload.
_MAX_MARKED_CELLS = 10_000


# --- number-format sections -------------------------------------------------


def _split_sections(fmt: str) -> list[str]:
    """Split a format on ``;`` outside quotes and escapes."""
    sections, current, quoted, index = [], "", False, 0
    while index < len(fmt):
        char = fmt[index]
        if char == "\\" and index + 1 < len(fmt):
            current += fmt[index:index + 2]
            index += 2
            continue
        if char == '"':
            quoted = not quoted
        if char == ";" and not quoted:
            sections.append(current)
            current = ""
        else:
            current += char
        index += 1
    sections.append(current)
    return sections


def _colour_token(token: str) -> str | None:
    name = token[1:-1].strip().lower()
    if name in _NAMED_COLOURS:
        return _NAMED_COLOURS[name]
    found = re.fullmatch(r"color\s*(\d+)", name)
    if found:
        hex_value = INDEXED_PALETTE.get(int(found.group(1)) + 7)
        return f"#{hex_value}" if hex_value else None
    return None


def _condition(section: str) -> tuple[str, float] | None:
    found = _CONDITION.match(_leading_brackets(section))
    return (found.group(1), float(found.group(2))) if found else None


def _leading_brackets(section: str) -> str:
    """The run of ``[..]`` tokens a section starts with, in order."""
    found = re.match(r"^(\[[^\]]*\])*", section)
    return "".join(_BRACKET.findall(found.group(0))) if found else ""


def _holds(value: float, condition: tuple[str, float]) -> bool:
    op, bound = condition
    return {
        "<": value < bound, "<=": value <= bound, ">": value > bound,
        ">=": value >= bound, "=": value == bound, "<>": value != bound,
    }[op]


def _pick(value: float, sections: list[str]) -> tuple[str, bool]:
    """The section a number shows through, and whether the value's sign is
    already spelled by that section (so the number prints unsigned)."""
    first, second = _condition(sections[0]), (_condition(sections[1]) if len(sections) > 1 else None)
    if first or second:
        if first and _holds(value, first):
            return sections[0], True
        if len(sections) > 1 and second and _holds(value, second):
            return sections[1], True
        if len(sections) > 2:
            return sections[2], True
        if len(sections) > 1 and not second:
            return sections[1], True
        return sections[0], False
    if len(sections) == 1 or value > 0 or (value == 0 and len(sections) < 3):
        return sections[0], False
    if value < 0:
        return sections[1], True
    return sections[2], True


def _render(section: str, value: float) -> str | None:
    """A section applied to a number: literals around the number pattern."""
    body = section
    prefix, digits, suffix, index = "", "", "", 0
    seen_digits = False
    while index < len(body):
        char = body[index]
        if char == "[":
            end = body.find("]", index)
            if end < 0:
                return None
            token = body[index:end + 1]
            if token.startswith("[$") and "-" not in token[2:3]:
                literal = token[2:-1].split("-")[0]
                if seen_digits:
                    suffix += literal
                else:
                    prefix += literal
            index = end + 1
            continue
        if char == "\\" and index + 1 < len(body):
            literal = body[index + 1]
            index += 2
        elif char == '"':
            end = body.find('"', index + 1)
            if end < 0:
                return None
            literal = body[index + 1:end]
            index = end + 1
        elif char == "_" and index + 1 < len(body):
            literal = " "
            index += 2
        elif char == "*" and index + 1 < len(body):
            literal = ""
            index += 2
        elif char in _DIGITS and not (char in ",." and not seen_digits and not digits):
            digits += char
            seen_digits = True
            index += 1
            continue
        elif char == "@":
            return None
        elif _DATE_TOKEN.match(char) or char in "Ee":
            return None
        else:
            literal = char
            index += 1
        if seen_digits:
            suffix += literal
        else:
            prefix += literal
    if not digits:
        return prefix + suffix
    number = _format_number(value, digits) if any(c in digits for c in "0#?") else _js_number(value)
    return prefix + number + suffix


def format_number_sections(value: float, fmt: str) -> tuple[str, str | None] | None:
    """The text and colour a number gets from an Excel format with sections.

    ``#,##0;[Red]\\(#,##0\\);\\-`` shows ``-1500000`` as ``(1,500,000)`` in red
    and ``0`` as ``-``. Returns ``None`` for a date or text format (the
    reader's own formatter keeps those).
    """
    sections = _split_sections(fmt)
    section, unsigned = _pick(value, sections)
    colour = None
    for token in _BRACKET.findall(_leading_brackets(section)):
        colour = _colour_token(token) or colour
    shown = abs(value) if unsigned else value
    text = _render(section, abs(shown))
    if text is None:
        return None
    if not unsigned and value < 0:
        text = "-" + text
    return text, colour


def _wants_sections(fmt: str) -> bool:
    return ";" in fmt or "[" in fmt or '"' in fmt or "\\" in fmt or "_" in fmt


# --- cells ------------------------------------------------------------------


def _blend(fg: str, bg: str, ink: float) -> str:
    a, b = int(fg[1:], 16), int(bg[1:], 16)
    channels = [
        round(((a >> shift) & 255) * ink + ((b >> shift) & 255) * (1 - ink))
        for shift in (16, 8, 0)
    ]
    return "#" + "".join(f"{channel:02X}" for channel in channels)


def _fill(cell: Any) -> tuple[dict[str, Any] | None, str | None]:
    """A non-solid fill as ``lcx.fill`` plus a flat fallback background."""
    fill = cell.fill
    if getattr(fill, "tagname", "") == "gradientFill":
        stops = [
            [round(float(stop.position), 4), _to_hex(stop.color) or "#FFFFFF"]
            for stop in fill.stop
        ]
        if not stops:
            return None, None
        kind = "path" if getattr(fill, "type", "linear") == "path" else "linear"
        spec = {"gradient": kind, "degree": float(getattr(fill, "degree", 0) or 0), "stops": stops}
        if kind == "linear" and spec["degree"].is_integer():
            spec["degree"] = int(spec["degree"])
        return spec, stops[0][1]
    pattern = getattr(fill, "patternType", None)
    if pattern in (None, "none", "solid"):
        return None, None
    fg = _to_hex(fill.fgColor) or "#000000"
    bg = _to_hex(fill.bgColor) or "#FFFFFF"
    return {"pattern": pattern, "fg": fg, "bg": bg}, _blend(fg, bg, _PATTERN_INK.get(pattern, 0.5))


def _cell_extras(cell: Any, cached: Any, v: dict[str, Any]) -> bool:
    """Mutate one Fortune cell with the read-only extras; True when its font
    colour came from the number format (a conditional format must not override it)."""
    format_coloured = False
    number = cached
    if isinstance(number, (int, float)) and not isinstance(number, bool):
        fmt = cell.number_format or ""
        if fmt and fmt != "General" and _wants_sections(fmt):
            shown = format_number_sections(float(number), fmt)
            if shown is not None:
                v["m"], colour = shown
                # The colour is decided here; Fortune's own "[Red]" check would
                # repaint every negative red whichever section carries it.
                fa = (v.get("ct") or {}).get("fa")
                if isinstance(fa, str) and "[Red]" in fa:
                    v["ct"] = {**v["ct"], "fa": fa.replace("[Red]", "")}
                if colour:
                    v["fc"] = colour
                    format_coloured = True
        v.setdefault("ct", {"fa": fmt or "General", "t": "n"})
        if getattr(cell.alignment, "horizontal", None) in (None, "general"):
            v.setdefault("ht", 2)  # Excel's General alignment puts numbers right, "-" included
    if getattr(cell.font, "strike", False):
        v["cl"] = 1
    lcx: dict[str, Any] = {}
    alignment = cell.alignment
    rotation = getattr(alignment, "textRotation", 0) or 0
    if rotation == 255:
        v["tr"] = "3"
    elif 0 < rotation <= 180:
        v["rt"] = int(rotation)
    indent = int(getattr(alignment, "indent", 0) or 0)
    if indent:
        lcx["indent"] = indent
    spec, fallback = _fill(cell)
    if spec:
        lcx["fill"] = spec
        if fallback:
            v["bg"] = fallback
    comment = getattr(cell, "comment", None)
    if comment is not None and comment.text:
        v["ps"] = {"value": comment.text.strip(), "isShow": False}
    if lcx:
        v["lcx"] = {**v.get("lcx", {}), **lcx}
    return format_coloured


def _unquote_sheet(address: str) -> str:
    """``'Sheet one'!A1`` as ``Sheet one!A1`` — Fortune looks the sheet up by its bare name."""
    found = re.fullmatch(r"'((?:[^']|'')+)'!(.+)", address)
    if not found:
        return address
    sheet = found.group(1).replace("''", "'")
    return f"{sheet}!{found.group(2)}"


def _link(cell: Any) -> dict[str, str] | None:
    link = getattr(cell, "hyperlink", None)
    if link is None:
        return None
    if getattr(link, "location", None):
        return {"linkType": "cellrange", "linkAddress": _unquote_sheet(str(link.location))}
    target = getattr(link, "target", None) or ""
    if target.startswith("#"):
        return {"linkType": "cellrange", "linkAddress": _unquote_sheet(target[1:])}
    if _SAFE_LINK.match(target):
        return {"linkType": "webpage", "linkAddress": target}
    return None


# --- sheets -----------------------------------------------------------------


def _hidden_rows(worksheet: Any) -> dict[int, int]:
    return {
        row - 1: 0
        for row, dimension in worksheet.row_dimensions.items()
        if getattr(dimension, "hidden", False)
    }


def _hidden_columns(worksheet: Any) -> dict[int, int]:
    hidden: dict[int, int] = {}
    for dimension in worksheet.column_dimensions.values():
        if not getattr(dimension, "hidden", False):
            continue
        low = dimension.min or 0
        high = dimension.max or low
        for column in range(low, min(high, low + 16384) + 1):
            if column >= 1:
                hidden[column - 1] = 0
    return hidden


def hidden_rows_and_columns(worksheet: Any) -> tuple[frozenset[int], frozenset[int]]:
    """0-based rows and columns the sheet hides — they take no space on the grid."""
    return frozenset(_hidden_rows(worksheet)), frozenset(_hidden_columns(worksheet))


def _dropdown_cells(worksheet: Any) -> list[tuple[int, int]]:
    cells: list[tuple[int, int]] = []
    for validation in getattr(worksheet.data_validations, "dataValidation", []) or []:
        if validation.type != "list" or validation.showDropDown:
            continue  # showDropDown=True means "hide the arrow" in the file format
        for cell_range in validation.sqref.ranges:
            for row in range(cell_range.min_row, cell_range.max_row + 1):
                for column in range(cell_range.min_col, cell_range.max_col + 1):
                    if len(cells) >= _MAX_MARKED_CELLS:
                        return cells
                    cells.append((row - 1, column - 1))
    return cells


def apply_read_only_fidelity(
    sheet: dict[str, Any], worksheet: Any, cached_sheet: Any
) -> None:
    """Add a read-only sheet's hidden state, links, tab colour and cell extras."""
    if worksheet.sheet_state in ("hidden", "veryHidden"):
        sheet["hide"] = 1
    tab = _to_hex(getattr(worksheet.sheet_properties, "tabColor", None))
    if tab:
        sheet["color"] = tab
    config = sheet["config"]
    rows, columns = _hidden_rows(worksheet), _hidden_columns(worksheet)
    if rows:
        config["rowhidden"] = rows
    if columns:
        config["colhidden"] = columns

    by_position = {(entry["r"], entry["c"]): entry["v"] for entry in sheet["celldata"]}
    links: dict[str, dict[str, str]] = {}
    format_coloured: set[tuple[int, int]] = set()
    for (row, column), v in by_position.items():
        if "mc" in v and "r" in v["mc"] and len(v) == 1:
            continue  # a cell a merge covers
        cell = worksheet.cell(row=row + 1, column=column + 1)
        if _cell_extras(cell, cached_sheet.cell(row=row + 1, column=column + 1).value, v):
            format_coloured.add((row, column))
        link = _link(cell)
        if link:
            links[f"{row}_{column}"] = link
            if link["linkType"] == "webpage":
                v["lcx"] = {**v.get("lcx", {}), "link": link["linkAddress"]}
    if links:
        sheet["hyperlink"] = links

    # Excel shows the arrow on the selected cell only; a grid nobody selects in
    # marks the cells that hold a chosen value, not every empty row the rule covers.
    for at in _dropdown_cells(worksheet):
        v = by_position.get(at)
        if v is None or v.get("m") in (None, ""):
            continue
        v["lcx"] = {**v.get("lcx", {}), "dropdown": True}

    _fit_rotated_rows(sheet, worksheet)

    from .xlsx_conditional import bake_conditional_formats

    bake_conditional_formats(sheet, worksheet, cached_sheet, format_coloured)


def _text_extent(text: str, size_pt: float) -> tuple[float, float]:
    """Rough width and height (px) of one line: full width for CJK, ~0.55em else."""
    em = size_pt * 4 / 3
    width = sum(em if ord(char) > 0x2E80 else em * 0.55 for char in text)
    return width, em * 1.2


def _fit_rotated_rows(sheet: dict[str, Any], worksheet: Any) -> None:
    """Grow rows Excel would auto-fit around rotated or stacked text.

    A row with a stored height keeps it; only auto-height rows grow, so the
    turned text is not clipped to Fortune's 19px default."""
    rowlen = sheet["config"].setdefault("rowlen", {})
    for entry in sheet["celldata"]:
        v = entry["v"]
        rotated, stacked = v.get("rt"), v.get("tr") == "3"
        if not rotated and not stacked:
            continue
        row = entry["r"]
        dimension = worksheet.row_dimensions.get(row + 1)
        if dimension is not None and dimension.height:
            continue
        width, height = _text_extent(str(v.get("m", "")), float(v.get("fs", 11)))
        if stacked:
            need = len(str(v.get("m", ""))) * height + 6
        else:
            angle = math.radians(rotated if rotated <= 90 else rotated - 90)
            need = width * abs(math.sin(angle)) + height * abs(math.cos(angle)) + 6
        rowlen[row] = max(rowlen.get(row, 0), round(need))


def open_first_visible(sheets: list[dict[str, Any]]) -> None:
    """Open the first sheet a person can see; a hidden first sheet stays shut."""
    visible = [index for index, sheet in enumerate(sheets) if not sheet.get("hide")]
    target = visible[0] if visible else 0
    for index, sheet in enumerate(sheets):
        sheet["status"] = 1 if index == target else 0
