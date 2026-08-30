"""``Canvas.open_deck`` / ``DeckHandle`` — the deck-protocol wire events.

Mirrors the pattern in ``test_emitter_commit.py``: a plain list stream_writer
stub captures every emitted event dict and asserts on the exact wire shape.
"""

from __future__ import annotations

from typing import Any

from langchain_canvas import Canvas


def test_open_deck_emits_create_with_slides_type_and_deck_meta() -> None:
    events: list[dict[str, Any]] = []
    canvas = Canvas(events.append)

    canvas.open_deck("Q3 Review", id="deck-1", ratio="16:9")

    create = next(e for e in events if e["type"] == "canvas.create")
    assert create["artifact"]["id"] == "deck-1"
    assert create["artifact"]["type"] == "slides"
    assert create["artifact"]["data"] == {"html": ""}
    assert create["artifact"]["meta"] == {"kind": "deck", "ratio": "16:9"}


def test_deck_handle_emits_slide_status_slide_patch_node_patch() -> None:
    events: list[dict[str, Any]] = []
    canvas = Canvas(events.append)
    deck = canvas.open_deck("Q3 Review", id="deck-1")

    deck.slide_status("slide-001", "extracting")
    deck.patch_slide("slide-001", "<section data-slide-id='slide-001'>hi</section>")
    deck.slide_status("slide-001", "complete")
    deck.patch_node("slide-001", "node-slide-001-1", "<p>updated</p>")

    status_events = [e for e in events if e["type"] == "canvas.slide_status"]
    assert status_events[0] == {
        "type": "canvas.slide_status",
        "id": "deck-1",
        "slideId": "slide-001",
        "stage": "extracting",
    }
    assert status_events[1]["stage"] == "complete"

    slide_patch = next(e for e in events if e["type"] == "canvas.slide_patch")
    assert slide_patch == {
        "type": "canvas.slide_patch",
        "id": "deck-1",
        "slideId": "slide-001",
        "templateHtml": "<section data-slide-id='slide-001'>hi</section>",
    }

    node_patch = next(e for e in events if e["type"] == "canvas.node_patch")
    assert node_patch == {
        "type": "canvas.node_patch",
        "id": "deck-1",
        "cid": "node-slide-001-1",
        "html": "<p>updated</p>",
        "slideId": "slide-001",
        "nodeId": "node-slide-001-1",
    }


def test_slide_status_detail_is_omitted_when_none() -> None:
    events: list[dict[str, Any]] = []
    canvas = Canvas(events.append)
    deck = canvas.open_deck("Q3 Review", id="deck-1")

    deck.slide_status("slide-001", "degraded", detail="text mutated by the model")

    status = next(e for e in events if e["type"] == "canvas.slide_status")
    assert status["detail"] == "text mutated by the model"

    events.clear()
    deck.slide_status("slide-002", "generating")
    status = next(e for e in events if e["type"] == "canvas.slide_status")
    assert "detail" not in status  # exclude_none keeps the wire lean


def test_deck_commit_chains_slide_conversion_saves_via_amends() -> None:
    # A burst of per-slide conversion commits should read as one work unit on
    # the version rail: the first commit has no amends, later ones amend it.
    events: list[dict[str, Any]] = []
    canvas = Canvas(events.append)
    deck = canvas.open_deck("Q3 Review", id="deck-1")

    deck.patch_slide("slide-001", "<section>1</section>")
    deck.commit("Convert slide 1", revision="v1")

    first_commit_id = "deck-1"  # commit id is the artifact id, not per-slide
    deck.patch_slide("slide-002", "<section>2</section>")
    deck.commit("Convert slide 2", revision="v2", amends=first_commit_id)

    commits = [e for e in events if e["type"] == "canvas.commit"]
    assert len(commits) == 2
    assert "amends" not in commits[0]
    assert commits[1]["amends"] == "deck-1"
    assert commits[1]["revision"] == "v2"


def test_deck_set_deck_html_emits_patch() -> None:
    events: list[dict[str, Any]] = []
    canvas = Canvas(events.append)
    deck = canvas.open_deck("Q3 Review", id="deck-1")

    deck.set_deck_html("<html>whole deck</html>")

    patch = next(e for e in events if e["type"] == "canvas.patch")
    assert patch == {
        "type": "canvas.patch",
        "id": "deck-1",
        "patch": {"html": "<html>whole deck</html>"},
    }
