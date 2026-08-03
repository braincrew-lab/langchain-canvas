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
