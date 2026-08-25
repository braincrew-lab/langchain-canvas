"""Folding a burst of commits into one version (``Commit.amends``).

Two halves: :func:`fold_history` groups a commit chain, and
:func:`hydrate_events` replays the folded history so a reloading client
sees the same versions the log folds to.
"""

from __future__ import annotations

from langchain_canvas.replay import hydrate_events
from langchain_canvas.store import Commit, InMemoryCanvasStore, fold_history


def _commit(revision: str, *, paths: list[str] | None = None, amends: str | None = None) -> Commit:
    return Commit(
        revision=revision,
        description=f"save {revision}",
        paths=paths if paths is not None else ["deck.slides.json"],
        amends=amends,
    )


def _newest_first(*commits: Commit) -> list[Commit]:
    """History order (what ``CanvasStore.history`` returns) from oldest args."""
    return list(reversed(commits))


# --- fold_history ---------------------------------------------------------------


def test_empty_history_folds_to_nothing() -> None:
    assert fold_history([]) == []


def test_commits_without_amends_are_left_alone() -> None:
    history = _newest_first(_commit("v1"), _commit("v2"), _commit("v3"))
    assert [c.revision for c in fold_history(history)] == ["v3", "v2", "v1"]


def test_a_chain_folds_to_its_latest_commit() -> None:
    history = _newest_first(
        _commit("v1"),
        _commit("v2", amends="v1"),
        _commit("v3", amends="v1"),
    )
    folded = fold_history(history)
    assert [c.revision for c in folded] == ["v3"]


def test_a_chain_keeps_the_position_it_started_at() -> None:
    # Someone starts a version at v1, another file lands at v3, then the
    # first version continues at v4 — the versions stay in start order.
    history = _newest_first(
        _commit("v1"),
        _commit("v2", amends="v1"),
        _commit("v3", paths=["notes.md"]),
        _commit("v4", amends="v1"),
    )
    assert [c.revision for c in fold_history(history)] == ["v3", "v4"]


def test_two_chains_fold_independently() -> None:
    history = _newest_first(
        _commit("v1"),
        _commit("v2", amends="v1"),
        _commit("v3"),
        _commit("v4", amends="v3"),
    )
    assert [c.revision for c in fold_history(history)] == ["v4", "v2"]


def test_commits_touching_other_files_never_fold_together() -> None:
    # A grouping policy that crossed files would erase the only record of
    # notes.md; the guard keeps it visible whatever amends says.
    history = _newest_first(
        _commit("v1"),
        _commit("v2", paths=["notes.md"], amends="v1"),
    )
    assert [c.revision for c in fold_history(history)] == ["v2", "v1"]


def test_an_unknown_root_still_folds_its_own_chain() -> None:
    # v1 is not in the window (a limited history read) — the commits that
    # continue it still read as one version.
    history = _newest_first(_commit("v2", amends="v1"), _commit("v3", amends="v1"))
    assert [c.revision for c in fold_history(history)] == ["v3"]


# --- hydrate_events -------------------------------------------------------------


def _commit_events(events: list[dict]) -> list[dict]:
    return [e for e in events if e["type"] == "canvas.commit"]


def _slides(text: str) -> str:
    return (
        '{"type": "slides", "title": "Deck", "data": {"slides": '
        f'[{{"layout": "title", "title": "{text}"}}]}}}}'
    )


def test_hydrate_replays_a_folded_burst_as_one_version() -> None:
    store = InMemoryCanvasStore()
    first = store.write("c1", "deck.slides.json", _slides("one"), "Manual edit", actor="human")
    for text in ("two", "three"):
        store.write(
            "c1",
            "deck.slides.json",
            _slides(text),
            "Manual edit",
            actor="human",
            amends=first.revision,
        )

    events = hydrate_events(store, "c1")
    commits = _commit_events(events)
    assert len(commits) == 1
    assert commits[0]["revision"] == "v3"
    # The version carries the latest content — nothing between is needed.
    created = next(e for e in events if e["type"] == "canvas.create")
    assert created["artifact"]["data"]["slides"][0]["title"] == "three"


def test_hydrate_splits_versions_where_the_actor_changes() -> None:
    store = InMemoryCanvasStore()
    mine = store.write("c1", "deck.slides.json", _slides("one"), "Manual edit", actor="human")
    store.write(
        "c1", "deck.slides.json", _slides("two"), "Manual edit", actor="human", amends=mine.revision
    )
    store.write("c1", "deck.slides.json", _slides("agent"), "Redraw", actor="agent")
    later = store.write("c1", "deck.slides.json", _slides("four"), "Manual edit", actor="human")
    store.write(
        "c1",
        "deck.slides.json",
        _slides("five"),
        "Manual edit",
        actor="human",
        amends=later.revision,
    )

    revisions = [e["revision"] for e in _commit_events(hydrate_events(store, "c1"))]
    assert revisions == ["v2", "v3", "v5"]


def test_hydrate_keeps_every_agent_write_as_its_own_version() -> None:
    store = InMemoryCanvasStore()
    for text in ("one", "two"):
        store.write("c1", "deck.slides.json", _slides(text), "Write deck", actor="agent")

    assert len(_commit_events(hydrate_events(store, "c1"))) == 2
