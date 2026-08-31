"""Vector clusters a PDF page draws as paths become positioned raster layers."""

import pytest

PDF_SCALE = 1280 / 612.0


def _vector_boxes(source) -> list[dict]:
    return [box for box in source.image_boxes if box.get("layer") == "vector"]


def test_extract_rasterizes_complex_vector_cluster_as_positioned_layer():
    from app.agent.pdf_source import extract_pdf_pages
    from template_source_fixtures import complex_vector_pdf_source

    source = extract_pdf_pages(complex_vector_pdf_source(), [1])[0]

    layers = _vector_boxes(source)
    assert len(layers) == 1
    layer = layers[0]
    assert layer["x"] == pytest.approx(320.0 * PDF_SCALE, abs=2)
    assert layer["y"] == pytest.approx((792.0 - 320.0) * PDF_SCALE, abs=2)
    assert layer["w"] == pytest.approx(160.0 * PDF_SCALE, abs=2)
    assert layer["h"] == pytest.approx(120.0 * PDF_SCALE, abs=2)
    assert layer["src"] in source.images
    assert source.images[layer["src"]].startswith(b"\x89PNG")


def test_extract_merges_adjacent_vector_clusters_into_one_layer():
    from app.agent.pdf_source import extract_pdf_pages
    from template_source_fixtures import complex_vector_pdf_source

    source = extract_pdf_pages(
        complex_vector_pdf_source(
            boxes=[(320.0, 200.0, 80.0, 120.0), (404.0, 200.0, 80.0, 120.0)]
        ),
        [1],
    )[0]

    layers = _vector_boxes(source)
    assert len(layers) == 1
    assert layers[0]["x"] == pytest.approx(320.0 * PDF_SCALE, abs=2)
    assert layers[0]["w"] == pytest.approx(164.0 * PDF_SCALE, abs=2)


def test_extract_excludes_vector_cluster_overlapping_text():
    from app.agent.pdf_source import extract_pdf_pages
    from template_source_fixtures import complex_vector_pdf_source

    source = extract_pdf_pages(
        complex_vector_pdf_source(
            boxes=[(70.0, 702.0, 20.0, 6.0)],
            texts=[("Alphabet Soup Section Title", 60.0, 700.0)],
        ),
        [1],
    )[0]

    assert _vector_boxes(source) == []


def test_prepare_pdf_html_accepts_vector_layer_src():
    from app.agent.pdf_deck import prepare_pdf_html
    from app.agent.pdf_source import extract_pdf_pages
    from template_source_fixtures import complex_vector_pdf_source

    source = extract_pdf_pages(complex_vector_pdf_source(), [1])[0]
    src = _vector_boxes(source)[0]["src"]

    clean = prepare_pdf_html(
        f'<section class="slide"><p>Alpha</p><img src="{src}"></section>', source
    )
    assert src in clean and "base64" not in clean
