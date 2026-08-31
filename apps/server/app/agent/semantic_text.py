"""Recover editable sentence units conservatively from positioned PDF fragments."""

from __future__ import annotations

import copy
import re
from typing import cast

from lxml import html as parser

from .render import measure_slide, viewport_for_ratio


def _style(node, updates):
    values = dict(re.findall(r"([\w-]+)\s*:\s*([^;]+)", node.get("style", "")))
    values.update(updates)
    node.set("style", "; ".join(f"{k}: {v}" for k, v in values.items()))


def consolidate_slide_html(
    html: str, *, ratio="16:9", style_css=""
) -> tuple[str, dict]:
    """Merge absolute text siblings across small gaps, never across grid boundaries.

    Semantic blocks and native PPTX shapes remain authoritative. Uncertain paragraph
    boundaries stay separate instead of destructively joining columns or table cells.
    """
    root = parser.fragment_fromstring(html, create_parent=True)
    used = {el.get("data-node-id") for el in root.iter() if el.get("data-node-id")}
    if len(used) != len(root.xpath(".//*[@data-node-id]")):
        raise ValueError("Duplicate data-node-id: normalization requires unique IDs")
    serial = 0
    for el in root.iterdescendants():
        if el.tag in {"style", "script", "br"} or el.get("data-node-id"):
            continue
        serial += 1
        while f"text-unit-{serial}" in used:
            serial += 1
        el.set("data-node-id", f"text-unit-{serial}")
        used.add(f"text-unit-{serial}")
    fragment = "".join(
        cast(str, parser.tostring(el, encoding="unicode")) for el in root
    )
    width, height = viewport_for_ratio(ratio)
    layout = measure_slide(
        f"<html><head><style>body{{margin:0;width:{width}px;height:{height}px}}*{{box-sizing:border-box}}{style_css}</style></head><body>{fragment}</body></html>",
        ratio=ratio,
    )
    nodes = {
        el.get("data-node-id"): el
        for el in root.iterdescendants()
        if el.get("data-node-id")
    }
    measured = {b["id"]: b for b in layout["textBlocks"] if b.get("id") in nodes}
    candidates = []
    for ident, box in measured.items():
        el = nodes[ident]
        if el.get("data-text-block") == "true":
            continue
        if (
            box["style"]["position"] == "absolute"
            and box["style"]["transform"] == "none"
            and not box.get("transformedAncestor")
            and box["style"]["left"].endswith("px")
            and box["style"]["top"].endswith("px")
            and not el.get("data-pptx-shape-id")
            and not el.xpath('.//img|.//*[@data-text-block="true"]')
            and not any(c.get("data-node-id") in measured for c in el.iterdescendants())
        ):
            candidates.append(box)
        else:
            el.set("data-text-block", "true")
    borders = [i for i in layout["items"] if i["kind"] == "line"]

    def divider(a, b, vertical):
        for edge in borders:
            if (
                vertical
                and abs(edge["x"] - edge["x2"]) < 2
                and a["x"] + a["w"] - 2 <= edge["x"] <= b["x"] + 2
                and min(edge["y"], edge["y2"])
                <= a["y"] + a["h"] / 2
                <= max(edge["y"], edge["y2"])
            ):
                return True
            if (
                not vertical
                and abs(edge["y"] - edge["y2"]) < 2
                and a["y"] + a["h"] - 2 <= edge["y"] <= b["y"] + 2
                and min(edge["x"], edge["x2"])
                <= a["x"] + a["w"] / 2
                <= max(edge["x"], edge["x2"])
            ):
                return True
        return False

    # Cluster baselines before sorting by x. Rounding y into buckets can put
    # neighboring words on opposite bucket edges and invert their reading order.
    rows = []
    for box in sorted(candidates, key=lambda b: (b["y"], b["x"])):
        size = float(box["style"]["font-size"].removesuffix("px"))
        if rows and abs(rows[-1][0]["y"] - box["y"]) <= max(3, size * 0.22):
            rows[-1].append(box)
        else:
            rows.append([box])
    groups = []
    for box in (b for row in rows for b in sorted(row, key=lambda b: b["x"])):
        size = float(box["style"]["font-size"].removesuffix("px"))
        for group in reversed(groups):
            prev = group[-1]
            previous_size = float(prev["style"]["font-size"].removesuffix("px"))
            gap = box["x"] - prev["x"] - prev["w"]
            if (
                nodes[prev["id"]].getparent() is nodes[box["id"]].getparent()
                and abs(prev["y"] - box["y"]) <= max(3, size * 0.22)
                and -size * 0.3 <= gap <= size * 0.9
                and abs(size - previous_size) <= max(2, size * 0.2)
                and not divider(prev, box, True)
            ):
                group.append(box)
                break
        else:
            groups.append([box])
    paragraphs = []
    for group in groups:
        first, last = group[0], group[-1]
        size = float(first["style"]["font-size"].removesuffix("px"))
        for paragraph in reversed(paragraphs):
            previous = paragraph[-1]
            a = previous[0]
            bottom = max(b["y"] + b["h"] for b in previous)
            if (
                nodes[a["id"]].getparent() is nodes[first["id"]].getparent()
                and abs(a["x"] - first["x"]) <= 3
                and -2 <= first["y"] - bottom <= size * 0.5
                and previous[-1]["x"] + previous[-1]["w"] - a["x"] > size * 4
                and last["x"] + last["w"] - first["x"] > size * 3
                and a["style"]["font-size"] == first["style"]["font-size"]
                and a["style"]["font-family"] == first["style"]["font-family"]
                and not re.match(r"\s*(?:[•●▪\-]|\d+[.)])", first["text"])
                and not divider({**a, "h": bottom - a["y"]}, first, False)
            ):
                paragraph.append(group)
                break
        else:
            paragraphs.append([group])
    removed, merged_roots = [], []
    for paragraph in paragraphs:
        boxes = [b for group in paragraph for b in group]
        first = nodes[boxes[0]["id"]]
        first.set("data-text-block", "true")
        if len(boxes) == 1:
            continue
        clone = copy.deepcopy(first)
        clone.text = None
        for child in list(clone):
            clone.remove(child)
        x, y = min(b["x"] for b in boxes), min(b["y"] for b in boxes)
        right, bottom = (
            max(b["x"] + b["w"] for b in boxes),
            max(b["y"] + b["h"] for b in boxes),
        )
        _style(
            clone,
            {
                "left": f"{x + float(boxes[0]['style']['left'][:-2]) - boxes[0]['x']:g}px",
                "top": f"{y + float(boxes[0]['style']['top'][:-2]) - boxes[0]['y']:g}px",
                "width": f"{right - x + 2:g}px",
                "height": f"{bottom - y:g}px",
                "white-space": "pre",
                "margin": "0",
                "padding": "0",
            },
        )
        for row, group in enumerate(paragraph):
            if row:
                clone.append(parser.Element("br"))
            for index, box in enumerate(group):
                original = nodes[box["id"]]
                span = parser.Element("span")
                diff = {
                    k: box["style"][k]
                    for k in [
                        "font-family",
                        "font-size",
                        "font-weight",
                        "font-style",
                        "color",
                        "letter-spacing",
                        "text-decoration",
                    ]
                    if box["style"][k] != boxes[0]["style"][k]
                }
                if diff:
                    _style(span, diff)
                span.text = original.text
                for child in original:
                    child = copy.deepcopy(child)
                    for descendant in child.iter():
                        descendant.attrib.pop("data-node-id", None)
                    span.append(child)
                if index:
                    prev = group[index - 1]
                    gap = box["advanceBounds"]["x"] - prev["advanceBounds"]["right"]
                    if (
                        not prev["text"][-1:].isspace()
                        and not prev["text"].endswith("·")
                        and not box["text"].startswith(tuple(" ,.;:!?)]}·"))
                        and gap > 0.5
                    ):
                        if len(clone):
                            clone[-1].tail = (clone[-1].tail or "") + " "
                        else:
                            clone.text = (clone.text or "") + " "
                if not len(span) and not span.attrib:
                    if len(clone):
                        clone[-1].tail = (clone[-1].tail or "") + (span.text or "")
                    else:
                        clone.text = (clone.text or "") + (span.text or "")
                else:
                    clone.append(span)
        first.getparent().replace(first, clone)
        merged_roots.append(clone)
        for box in boxes[1:]:
            node = nodes[box["id"]]
            node.getparent().remove(node)
            removed.append(box["id"])
    result = "".join(cast(str, parser.tostring(el, encoding="unicode")) for el in root)
    if merged_roots:
        # PDF fragments have glyph-tight widths. Measure the connected text once
        # without wrapping, then allocate a real editing box within its column.
        natural = measure_slide(
            f"<style>body{{margin:0;width:{width}px;height:{height}px}}{style_css}</style>"
            + result,
            ratio=ratio,
        )
        natural_by_id = {b["id"]: b for b in natural["textBlocks"]}
        for node in merged_roots:
            box = natural_by_id[node.get("data-node-id")]
            required = max(box["w"], box["advanceBounds"]["right"] - box["x"] + 2)
            limit = width - box["x"]
            for edge in borders:
                if (
                    abs(edge["x"] - edge["x2"]) < 2
                    and edge["x"] > box["x"] + box["w"] - 2
                    and min(edge["y"], edge["y2"])
                    <= box["y"] + box["h"] / 2
                    <= max(edge["y"], edge["y2"])
                ):
                    limit = min(limit, edge["x"] - box["x"] - 2)
            _style(
                node,
                {"width": f"{min(required, limit):g}px", "white-space": "pre-wrap"},
            )
        result = "".join(
            cast(str, parser.tostring(el, encoding="unicode")) for el in root
        )
    return result, {
        "merged": len(removed),
        "before": len(measured),
        "after": len(measured) - len(removed),
        "removed_node_ids": removed,
        "warnings": [
            "Ambiguous columns, table boundaries and native PPTX shapes remain separate."
        ],
    }
