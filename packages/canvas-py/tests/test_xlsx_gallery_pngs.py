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
