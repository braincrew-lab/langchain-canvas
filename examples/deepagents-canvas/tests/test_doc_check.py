"""Unit tests for the document checker's pure logic (no browser needed)."""

from doc_check import DOC_WIDTH, document_report, missing_phrases


def metrics(**overrides):
    base = {
        "overflowX": 0,
        "external": [],
        "brokenImages": 0,
        "headings": 2,
        "smallText": 0,
        "textLength": 500,
        "text": "Overview of the API. Key features and usage guidance.",
    }
    base.update(overrides)
    return base


def test_clean_document_is_all_clear():
    report = document_report("report/01-intro.html", metrics(), [])
    assert "0 error(s), 0 warning(s)" in report
    assert "All clear." in report


def test_horizontal_overflow_is_an_error():
    report = document_report("f.html", metrics(overflowX=120), [])
    assert "ERROR" in report
    assert "120px" in report
    assert str(DOC_WIDTH) in report


def test_external_resources_are_errors():
    report = document_report("f.html", metrics(external=["<script>", "<iframe>"]), [])
    assert report.count("ERROR: external resource") == 2


def test_missing_expected_phrase_is_an_error():
    missing = missing_phrases("The quick brown fox", ["핵심 API 기능"])
    assert missing == ["핵심 API 기능"]
    report = document_report("f.html", metrics(), missing)
    assert 'requested content not found in the rendered text: "핵심 API 기능"' in report


def test_expect_matches_across_whitespace():
    assert missing_phrases("핵심\n  API   기능 정리", ["핵심 API 기능"]) == []


def test_structure_and_size_warnings():
    report = document_report("f.html", metrics(headings=0, smallText=3, textLength=10), [])
    assert "0 error(s), 3 warning(s)" in report
    assert report.count("WARNING") == 3


def test_broken_images_warn():
    report = document_report("f.html", metrics(brokenImages=1), [])
    assert "0 error(s), 1 warning(s)" in report
    assert "data: URIs" in report
