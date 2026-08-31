"""Grouping repeated page layouts into stable, deterministic representatives.

Takes the render-free census from :mod:`langchain_canvas.deck.source_inventory`
and finds which observed pages share the same layout shape — so a late body
or comparison slide is found by its structure, not by being one of the first
three pages. Grouping and medoid selection are both fully deterministic: the
same census always produces the same groups in the same order, which is what
lets a follow-up call (a later page range) be merged without re-ranking pages
already reported.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .source_inventory import PageInventory, TextBoxCensus

__all__ = ["PatternGroup", "select_representatives"]

# Boxes are quantized to this grid before joining the group signature, so two
# pages whose boxes differ by a few px of layout jitter still group together.
_BOX_QUANTIZE_STEP = 0.05


@dataclass(frozen=True)
class PatternGroup:
    """One repeated layout: its member pages and the chosen representative."""

    pattern_id: str
    member_pages: tuple[int, ...]
    representative_page: int
    support_count: int
    roles: tuple[str, ...]
    capability_issues: tuple[str, ...]
    examples: dict[str, list[str]]
    confidence_basis: str


def select_representatives(pages: list[PageInventory]) -> list[PatternGroup]:
    """Group census pages by stable layout signature and pick each medoid.

    Groups are sorted by frequency descending, then by representative page
    ascending (the tie-break for equal frequency). Within a group, the medoid
    is the real member page with the smallest total box-distance to every
    other member; ties go to the lowest original page number.
    """
    scored_pages = [page for page in pages if page.has_text]
    signature_to_pages: dict[tuple[Any, ...], list[PageInventory]] = {}
    for page in scored_pages:
        signature_to_pages.setdefault(_signature(page), []).append(page)

    groups: list[PatternGroup] = []
    for signature, members in signature_to_pages.items():
        representative = _medoid(members)
        roles = tuple(sorted({box.role for box in representative.text_boxes}))
        capability_issues = tuple(
            dict.fromkeys(
                issue for member in members for issue in member.capability_issues
            )
        )
        groups.append(
            PatternGroup(
                pattern_id="",  # assigned below, once the final order is known
                member_pages=tuple(sorted(member.page_number for member in members)),
                representative_page=representative.page_number,
                support_count=len(members),
                roles=roles,
                capability_issues=capability_issues,
                examples=_examples(representative),
                confidence_basis=_confidence_basis(signature, len(members)),
            )
        )

    groups.sort(key=lambda group: (-group.support_count, group.representative_page))
    return [
        PatternGroup(
            pattern_id=f"pattern-{index + 1}",
            member_pages=group.member_pages,
            representative_page=group.representative_page,
            support_count=group.support_count,
            roles=group.roles,
            capability_issues=group.capability_issues,
            examples=group.examples,
            confidence_basis=group.confidence_basis,
        )
        for index, group in enumerate(groups)
    ]


def _quantize(value: float) -> float:
    return round(round(value / _BOX_QUANTIZE_STEP) * _BOX_QUANTIZE_STEP, 2)


def _quantized_box(box: TextBoxCensus) -> tuple[float, float, float, float]:
    return (_quantize(box.x), _quantize(box.y), _quantize(box.w), _quantize(box.h))


def _signature(page: PageInventory) -> tuple[Any, ...]:
    """A page's stable grouping key: role counts, object kinds, language, boxes.

    Boxes are quantized and order-independent (a ``frozenset``-like sorted
    tuple) so two pages with the same layout in a different shape-insertion
    order still land in the same group.
    """
    roles_present = {box.role for box in page.text_boxes}
    role_counts = tuple(
        sorted(
            (role, sum(1 for box in page.text_boxes if box.role == role))
            for role in roles_present
        )
    )
    object_kind_counts = tuple(sorted(page.object_kind_counts.items()))
    quantized_boxes = tuple(sorted(_quantized_box(box) for box in page.text_boxes))
    return (role_counts, object_kind_counts, page.language, quantized_boxes)


def _box_distance(a: PageInventory, b: PageInventory) -> float:
    """Sum of box-center distances between two pages with matching box counts.

    Boxes are paired by position order (sorted the same way on both sides)
    since same-signature pages share the same role/kind counts and quantized
    box set shape.
    """
    boxes_a = sorted(a.text_boxes, key=lambda box: (box.y, box.x))
    boxes_b = sorted(b.text_boxes, key=lambda box: (box.y, box.x))
    total = 0.0
    for box_a, box_b in zip(boxes_a, boxes_b, strict=True):
        center_a = (box_a.x + box_a.w / 2, box_a.y + box_a.h / 2)
        center_b = (box_b.x + box_b.w / 2, box_b.y + box_b.h / 2)
        total += ((center_a[0] - center_b[0]) ** 2 + (center_a[1] - center_b[1]) ** 2) ** 0.5
    return total


def _medoid(members: list[PageInventory]) -> PageInventory:
    if len(members) == 1:
        return members[0]
    best: PageInventory | None = None
    best_distance = float("inf")
    for candidate in sorted(members, key=lambda page: page.page_number):
        distance = sum(_box_distance(candidate, other) for other in members)
        if distance < best_distance:
            best_distance = distance
            best = candidate
    assert best is not None
    return best


def _examples(representative: PageInventory) -> dict[str, list[str]]:
    """Up to 2 example texts per role, each capped at 160 characters."""
    examples: dict[str, list[str]] = {}
    for box in representative.text_boxes:
        bucket = examples.setdefault(box.role, [])
        if len(bucket) < 2:
            bucket.append(box.text[:160])
    return examples


def _confidence_basis(signature: tuple[Any, ...], support_count: int) -> str:
    role_counts, object_kind_counts, _language, _boxes = signature
    roles_desc = ", ".join(f"{count} {role}" for role, count in role_counts) or "no text roles"
    kinds_desc = (
        ", ".join(f"{count} {kind}" for kind, count in object_kind_counts) or "no other objects"
    )
    return f"{support_count} pages share {roles_desc} and {kinds_desc}"
