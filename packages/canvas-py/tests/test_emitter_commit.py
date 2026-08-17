"""The ``canvas.commit`` wire event, emitted through a handle."""

from __future__ import annotations

from typing import Any

from langchain_canvas import Canvas


def test_handle_commit_emits_wire_event() -> None:
    events: list[dict[str, Any]] = []
    canvas = Canvas(events.append)
    page = canvas.open_html(title="Coffee history")

    page.set_html("<h1>Hi</h1>")
    page.commit("Create page", revision="v1")

    commit = next(e for e in events if e["type"] == "canvas.commit")
    assert commit == {
        "type": "canvas.commit",
        "id": page.id,
        "description": "Create page",
        "revision": "v1",
    }


def test_open_html_meta_rides_the_create_event() -> None:
    events: list[dict[str, Any]] = []
    canvas = Canvas(events.append)
    canvas.open_html(title="Slide 1", id="01-intro.html", meta={"kind": "slide", "ratio": "16:9"})

    create = next(e for e in events if e["type"] == "canvas.create")
    assert create["artifact"]["meta"] == {"kind": "slide", "ratio": "16:9"}


def test_open_html_without_meta_keeps_the_wire_lean() -> None:
    events: list[dict[str, Any]] = []
    canvas = Canvas(events.append)
    canvas.open_html(title="Page")

    create = next(e for e in events if e["type"] == "canvas.create")
    assert "meta" not in create["artifact"]  # exclude_none drops it


def test_commit_without_revision_omits_the_field() -> None:
    events: list[dict[str, Any]] = []
    canvas = Canvas(events.append)
    doc = canvas.open_document(title="Notes")
    doc.commit("Manual edit: 1 change")

    commit = next(e for e in events if e["type"] == "canvas.commit")
    assert "revision" not in commit  # exclude_none keeps the wire lean
    assert commit["description"] == "Manual edit: 1 change"


def test_open_chart_carries_options_and_echarts_option() -> None:
    # The TS renderer reads options.title and echartsOption; the emitter must
    # be able to send them (protocol parity is enforced by test_protocol_parity).
    from langchain_canvas.protocol import ChartOptions, ChartSeries

    events: list[dict[str, Any]] = []
    canvas = Canvas(events.append)
    canvas.open_chart(
        title="Revenue",
        chart="bar",
        x_key="quarter",
        series=[ChartSeries(key="value")],
        options=ChartOptions(title="Quarterly revenue", stacked=True),
        echarts_option={"series": [{"type": "bar"}]},
    )

    data = next(e for e in events if e["type"] == "canvas.create")["artifact"]["data"]
    assert data["options"] == {"stacked": True, "title": "Quarterly revenue"}
    assert data["echartsOption"] == {"series": [{"type": "bar"}]}
