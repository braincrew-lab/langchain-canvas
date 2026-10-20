"""Which bytes a host's crop may be: a whole PNG no larger than our own renderer makes.

A crop is placed as an image the viewer decodes, so it must be a complete PNG (every chunk
inside the data and checksummed, IHDR first, an IDAT, IEND last) whose size our gallery
render could have produced.
"""

from __future__ import annotations

import struct
import zlib

import pytest
from test_xlsx_gallery import _GalleryHost, _png, _preview
from test_xlsx_gallery_crops import _five_chart_workbook, _ids

from langchain_canvas.xlsx_gallery import is_usable_png

_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _chunk(kind: bytes, body: bytes, *, crc: int | None = None) -> bytes:
    checksum = zlib.crc32(kind + body) if crc is None else crc
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", checksum)


def _bit_png(width: int, height: int) -> bytes:
    """A complete 1-bit PNG; blank rows compress to a few KB however large the picture."""
    rows = (b"\x00" + bytes((width + 7) // 8)) * height
    header = struct.pack(">IIBBBBB", width, height, 1, 0, 0, 0, 0)
    return (
        _SIGNATURE + _chunk(b"IHDR", header) + _chunk(b"IDAT", zlib.compress(rows))
        + _chunk(b"IEND", b"")
    )


def _chunks(png: bytes) -> list[bytes]:
    found, at = [], 8
    while at < len(png):
        (length,) = struct.unpack(">I", png[at : at + 4])
        found.append(png[at : at + 12 + length])
        at += 12 + length
    return found


def _broken() -> dict[str, bytes]:
    ihdr, idat, iend = _chunks(_png())
    bad_crc = ihdr[:-4] + struct.pack(">I", struct.unpack(">I", ihdr[-4:])[0] ^ 1)
    return {
        "only the first 24 bytes": _png()[:24],
        "ihdr checksum is wrong": _SIGNATURE + bad_crc + idat + iend,
        "idat checksum is wrong": _SIGNATURE + ihdr + idat[:-1] + b"\x00" + iend,
        "no idat": _SIGNATURE + ihdr + iend,
        "no iend": _SIGNATURE + ihdr + idat,
        "cut inside a chunk": _png()[:-9],
        "data after iend": _png() + b"\x00",
        "ihdr is not first": _SIGNATURE + idat + ihdr + iend,
        "ihdr of the wrong length": _SIGNATURE + _chunk(b"IHDR", b"\x00" * 12) + idat + iend,
        "a chunk longer than the data": _SIGNATURE + ihdr + struct.pack(">I", 10**6) + b"IDAT",
    }


def test_a_complete_png_is_usable() -> None:
    assert is_usable_png(_png()) and is_usable_png(bytearray(_png(7, 3, pad=500)))


@pytest.mark.parametrize("name", sorted(_broken()))
def test_a_png_that_is_not_whole_is_not_usable(name: str) -> None:
    assert not is_usable_png(_broken()[name])


def test_a_broken_png_is_not_placed_and_the_chart_pages_are_listed() -> None:
    for broken in _broken().values():
        data = _preview(_five_chart_workbook(), _GalleryHost(png=broken))
        assert _ids(data) == []
        assert data["chartPages"] == [2]


# The gallery draws a chart at 1600x1200 px at most (1200 pt) and the converter renders a crop
# at 8x at most, so a side stays within 9,600 px and the area within 8 megapixels (the tallest
# narrow chart: 720 x 7,200 px = 5.2 MP). The bounds are 10,000 px a side and 16 megapixels.
def test_a_complete_png_of_20000_by_20000_is_refused() -> None:
    huge = _bit_png(20_000, 20_000)

    assert len(huge) < 100_000  # small enough to pass any byte cap
    assert not is_usable_png(huge)


@pytest.mark.parametrize(
    ("width", "height", "usable"),
    [
        (2400, 1800, True),  # a 1200x900 pt chart at the minimum scale
        (720, 7200, True),  # the tallest narrow chart at the maximum scale
        (10_000, 1, True),
        (10_001, 1, False),
        (1, 10_001, False),
        (4000, 4000, True),  # 16 megapixels
        (4000, 4001, False),
    ],
)
def test_the_size_of_a_png_is_bounded_by_what_the_gallery_can_render(
    width: int, height: int, usable: bool
) -> None:
    assert is_usable_png(_bit_png(width, height)) is usable


def test_an_oversized_png_is_not_placed() -> None:
    data = _preview(_five_chart_workbook(), _GalleryHost(png=_bit_png(20_000, 20_000)))

    assert _ids(data) == []
    assert data["chartPages"] == [2]


# --- the pixel data must be what the header says ---------------------------------------------


def _image(
    width: int = 3, height: int = 2, *, depth: int = 8, ctype: int = 2, interlace: int = 0,
    method: int = 0, rows: int | None = None, idats: list[bytes] | None = None,
    between: bytes = b"", before: bytes = b"", after_stream: bytes = b"",
) -> bytes:
    """A PNG with correct CRCs whose header and pixel data can each be made to disagree."""
    channels = {0: 1, 2: 3, 4: 2, 6: 4}.get(ctype, 1)
    row = b"\x00" + bytes((width * channels * depth + 7) // 8)
    stream = zlib.compress(row * (height if rows is None else rows)) + after_stream
    header = struct.pack(">IIBBBBB", width, height, depth, ctype, method, 0, interlace)
    parts = idats if idats is not None else [stream]
    data = (_chunk(b"IDAT", parts[0]) + between + b"".join(_chunk(b"IDAT", p) for p in parts[1:]))
    return (
        _SIGNATURE + before + _chunk(b"IHDR", header) + data + _chunk(b"IEND", b"")
    )


_SMALL_HEADER = struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0)
_TWO_ROWS = zlib.compress((b"\x00" + bytes(9)) * 2)  # the pixel data of a 3x2 RGB image


def _bad_pixel_data() -> dict[str, bytes]:
    stream = _TWO_ROWS
    return {
        "idat is not zlib": _image(idats=[b"not zlib"]),
        "idat is empty": _image(idats=[b""]),
        "one row short": _image(rows=1),
        "one row too many": _image(rows=3),
        "no rows at all": _image(rows=0),
        "stream cut before its end": _image(idats=[stream[:-6]]),
        "bytes after the stream": _image(after_stream=b"\x00"),
        "idat chunks apart": _image(
            idats=[stream[:5], stream[5:]], between=_chunk(b"tEXt", b"k\x00v")
        ),
        "a second ihdr": _image(before=_chunk(b"IHDR", _SMALL_HEADER)),
        "interlaced": _image(interlace=1),
        "palette image": _image(ctype=3),
        "depth the color type lacks": _image(depth=1, ctype=2),
        "unknown color type": _image(ctype=5),
        "unknown compression": _image(method=1),
    }


@pytest.mark.parametrize("name", sorted(_bad_pixel_data()))
def test_a_png_whose_pixel_data_does_not_fit_its_header_is_not_usable(name: str) -> None:
    assert not is_usable_png(_bad_pixel_data()[name])


def test_a_small_header_in_front_of_a_huge_one_is_not_usable() -> None:
    small = _chunk(b"IHDR", _SMALL_HEADER)
    huge = _bit_png(20_000, 20_000)

    assert not is_usable_png(_SIGNATURE + small + huge[8:])


@pytest.mark.parametrize(
    "png",
    [
        _image(),  # 8-bit RGB: what the converter writes
        _image(ctype=6),  # RGBA
        _image(depth=16, ctype=2),
        _image(5, 7, depth=1, ctype=0),
        _image(depth=8, ctype=4),
        _image(idats=[_TWO_ROWS[:5], _TWO_ROWS[5:]]),
    ],
    ids=["rgb8", "rgba8", "rgb16", "gray1", "gray-alpha8", "two idat chunks"],
)
def test_pngs_of_the_kinds_a_renderer_writes_are_usable(png: bytes) -> None:
    assert is_usable_png(png)


def test_a_pixel_bomb_is_not_inflated_past_what_the_header_allows(monkeypatch) -> None:
    import langchain_canvas.xlsx_gallery as xlsx_gallery

    asked: list[int] = []
    real = zlib.decompressobj

    class _Spy:
        def __init__(self) -> None:
            self._inner = real()

        def decompress(self, data: bytes, limit: int) -> bytes:
            asked.append(limit)
            return self._inner.decompress(data, limit)

        def __getattr__(self, name: str):
            return getattr(self._inner, name)

    monkeypatch.setattr(xlsx_gallery.zlib, "decompressobj", _Spy)
    bomb = _image(2, 2, idats=[zlib.compress(bytes(50_000_000))])

    assert not is_usable_png(bomb)
    assert asked and max(asked) <= 1 << 20 and len(asked) < 10


# --- every row must open with a real filter type, and chunk types must be well formed --------


def _png_of_rows(rows: bytes, width: int, height: int, *, extra: bytes = b"") -> bytes:
    """An 8-bit RGB PNG whose inflated rows are exactly ``rows``, with ``extra`` before IDAT."""
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        _SIGNATURE
        + _chunk(b"IHDR", header)
        + extra
        + _chunk(b"IDAT", zlib.compress(rows))
        + _chunk(b"IEND", b"")
    )


def test_a_row_filter_byte_outside_zero_to_four_is_not_usable() -> None:
    assert not is_usable_png(_png_of_rows(b"\x05\x00\x00\x00", 1, 1))
    assert is_usable_png(_png_of_rows(b"\x04\x00\x00\x00", 1, 1))


def test_a_bad_filter_byte_in_a_later_row_across_an_inflate_step_is_not_usable() -> None:
    # 1 MiB step: the bad byte sits at the start of a row that begins inside the second step.
    width, height = 1000, 1100  # row = 3001 bytes, 3.3 MB in all: three inflate steps
    row = 1 + 3 * width
    bad_row = (1 << 20) // row + 1  # first row that starts past the first step
    rows = bytearray(row * height)
    rows[bad_row * row] = 9
    assert not is_usable_png(_png_of_rows(bytes(rows), width, height))
    rows[bad_row * row] = 4
    assert is_usable_png(_png_of_rows(bytes(rows), width, height))


def test_an_unknown_critical_chunk_is_not_usable() -> None:
    assert not is_usable_png(_png_of_rows(bytes(4), 1, 1, extra=_chunk(b"ABCD", b"")))


def test_a_chunk_type_that_is_not_four_ascii_letters_is_not_usable() -> None:
    for kind in (b"tE1t", b"t\xc3\xa9X", b"\x00\x00\x00\x00"):
        assert not is_usable_png(_png_of_rows(bytes(4), 1, 1, extra=_chunk(kind, b"")))


def test_an_ancillary_chunk_is_still_usable() -> None:
    extra = _chunk(b"tEXt", b"k\x00v") + _chunk(b"pHYs", bytes(9))
    assert is_usable_png(_png_of_rows(bytes(4), 1, 1, extra=extra))
