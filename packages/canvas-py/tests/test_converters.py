"""Source converters — the pluggable bytes-to-blocks contract."""

from __future__ import annotations

from langchain_canvas.converters import (
    ConvertedSource,
    TextSourceConverter,
    converter_for,
    default_converters,
)


def test_text_converter_decodes_utf8_bom() -> None:
    data = "﻿분석명,값\n표본,64\n".encode()
    got = TextSourceConverter().convert(data, path="sources/report.csv")
    assert got.blocks[0]["text"].startswith("분석명")
    assert got.metadata["encoding"] == "utf-8-sig"


def test_text_converter_falls_back_to_cp949() -> None:
    data = "한글 문서".encode("cp949")
    got = TextSourceConverter().convert(data, path="sources/note.txt")
    assert got.blocks[0]["text"] == "한글 문서"
    assert got.metadata["encoding"] == "cp949"


def test_text_converter_is_lossy_but_honest_on_unknown_bytes() -> None:
    got = TextSourceConverter().convert(b"\xff\xfe\x00abc", path="sources/x.txt")
    assert got.metadata["encoding"] == "unknown (lossy utf-8)"
    assert "abc" in got.blocks[0]["text"]


def test_converter_for_matches_suffix_case_insensitively() -> None:
    converters = default_converters()
    assert converter_for("sources/NOTES.MD", converters) is not None
    assert converter_for("sources/photo.png", converters) is None


def test_custom_converter_plugs_in() -> None:
    class UpperConverter:
        suffixes = (".shout",)

        def convert(self, data: bytes, *, path: str) -> ConvertedSource:
            return ConvertedSource(blocks=[{"type": "text", "text": data.decode().upper()}])

    got = converter_for("sources/a.shout", [UpperConverter()])
    assert got is not None
    assert got.convert(b"hi", path="sources/a.shout").blocks[0]["text"] == "HI"


def _tiny_xlsx() -> bytes:
    import io

    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "Scores"
    ws.append(["model", "score"])
    ws.append(["A", 91])
    ws.append(["B", 87])
    wb.create_sheet("Notes").append(["비고", "테스트"])
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


def test_xlsx_converter_renders_each_sheet() -> None:
    from langchain_canvas.converters import XlsxSourceConverter

    got = XlsxSourceConverter().convert(_tiny_xlsx(), path="sources/scores.xlsx")
    text = got.blocks[0]["text"]
    assert "### sheet: Scores" in text
    assert "model,score" in text
    assert "A,91" in text
    assert "### sheet: Notes" in text
    assert "비고,테스트" in text
    assert got.metadata["sheets"] == "Scores, Notes"


def test_xlsx_converter_is_in_the_default_set() -> None:
    assert converter_for("sources/report.xlsx", default_converters()) is not None
