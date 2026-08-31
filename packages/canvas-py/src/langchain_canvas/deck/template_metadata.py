"""Model-independent validation for a deck's ``lcx:template`` metadata.

The metadata is neutral connective tissue between a pinned template artifact
and the writer instances that filled it (see plan U3/U4): it never carries
model output, only refs, slide-id-keyed instance maps, and the original
request contract. This module owns structural/size validation only — it has
no opinion on how the caller produced the payload, so it stays independent
of any app-layer request model.
"""

from __future__ import annotations

import json

SCHEMA_VERSION = 1
MAX_METADATA_BYTES = 256 * 1024
MAX_FACTS_PER_INSTANCE = 32
MAX_FACT_TEXT_CHARS = 1000
MAX_SLOTS_PER_INSTANCE = 64
MAX_SLOT_TEXT_CHARS = 4000

_REF_KEYS = {"path", "revision", "sha256"}
_REQUEST_KEYS = {
    "mode",
    "locale",
    "required_facts",
    "input_slots",
    "verbatim_expectations",
}
_INSTANCE_KEYS = {
    "archetype_id",
    "source_page",
    "slot_content_sha256",
    "request",
    "fact_to_slot",
}


class TemplateMetadataError(ValueError):
    """``lcx:template`` metadata that fails structural or size validation."""


def _require(condition: object, message: str) -> None:
    if not condition:
        raise TemplateMetadataError(message)


def _validate_ref(ref: object, *, field: str) -> None:
    _require(isinstance(ref, dict), f"{field} must be an object")
    assert isinstance(ref, dict)
    _require(set(ref) == _REF_KEYS, f"{field} must have exactly {sorted(_REF_KEYS)}")
    for key in _REF_KEYS:
        value = ref[key]
        _require(isinstance(value, str) and value, f"{field}.{key} must be a non-empty string")


def _validate_fact(fact: object, *, field: str) -> None:
    _require(isinstance(fact, dict) and set(fact) == {"id", "text"}, f"{field} must have id/text")
    assert isinstance(fact, dict)
    _require(isinstance(fact["id"], str) and fact["id"], f"{field}.id must be a non-empty string")
    text = fact["text"]
    _require(
        isinstance(text, str) and 0 < len(text) <= MAX_FACT_TEXT_CHARS,
        f"{field}.text must be 1..{MAX_FACT_TEXT_CHARS} characters",
    )


def _validate_facts(facts: object, *, field: str) -> None:
    _require(isinstance(facts, list), f"{field} must be a list")
    assert isinstance(facts, list)
    _require(
        len(facts) <= MAX_FACTS_PER_INSTANCE, f"{field} exceeds {MAX_FACTS_PER_INSTANCE} facts"
    )
    for index, fact in enumerate(facts):
        _validate_fact(fact, field=f"{field}[{index}]")


def _validate_slot_map(slot_map: object, *, field: str) -> None:
    _require(isinstance(slot_map, dict), f"{field} must be an object")
    assert isinstance(slot_map, dict)
    _require(
        len(slot_map) <= MAX_SLOTS_PER_INSTANCE, f"{field} exceeds {MAX_SLOTS_PER_INSTANCE} slots"
    )
    for key, runs in slot_map.items():
        _require(isinstance(key, str) and key, f"{field} keys must be non-empty strings")
        _require(isinstance(runs, list), f"{field}[{key}] must be a list of runs")
        for run in runs:
            _require(
                isinstance(run, str) and len(run) <= MAX_SLOT_TEXT_CHARS,
                f"{field}[{key}] runs must be <= {MAX_SLOT_TEXT_CHARS} characters",
            )


def _validate_request(request: object, *, field: str) -> None:
    _require(isinstance(request, dict), f"{field} must be an object")
    assert isinstance(request, dict)
    _require(set(request) <= _REQUEST_KEYS, f"{field} has unknown fields")
    _require({"mode", "locale", "input_slots"} <= set(request), f"{field} is missing fields")
    _require(request["mode"] in ("verbatim", "rewrite"), f"{field}.mode must be verbatim/rewrite")
    locale = request["locale"]
    _require(isinstance(locale, str) and locale, f"{field}.locale must be a non-empty string")
    _validate_facts(request.get("required_facts", []), field=f"{field}.required_facts")
    _validate_slot_map(request["input_slots"], field=f"{field}.input_slots")
    expectations = request.get("verbatim_expectations")
    if request["mode"] == "verbatim":
        _require(expectations is not None, f"{field}.verbatim_expectations is required")
        _validate_slot_map(expectations, field=f"{field}.verbatim_expectations")
    else:
        _require(expectations is None, f"{field}.verbatim_expectations must be omitted")


def _validate_instance(instance: object, *, field: str) -> None:
    _require(isinstance(instance, dict), f"{field} must be an object")
    assert isinstance(instance, dict)
    _require(set(instance) == _INSTANCE_KEYS, f"{field} must have exactly {sorted(_INSTANCE_KEYS)}")
    archetype_id = instance["archetype_id"]
    _require(isinstance(archetype_id, str) and archetype_id, f"{field}.archetype_id required")
    source_page = instance["source_page"]
    _require(isinstance(source_page, int) and source_page >= 0, f"{field}.source_page invalid")
    content_hash = instance["slot_content_sha256"]
    _require(
        isinstance(content_hash, str) and content_hash, f"{field}.slot_content_sha256 required"
    )
    _validate_request(instance["request"], field=f"{field}.request")
    fact_to_slot = instance["fact_to_slot"]
    _require(isinstance(fact_to_slot, dict), f"{field}.fact_to_slot must be an object")
    assert isinstance(fact_to_slot, dict)
    for key, value in fact_to_slot.items():
        _require(
            isinstance(key, str) and isinstance(value, str),
            f"{field}.fact_to_slot must map strings to strings",
        )


def validate_template_metadata(payload: dict, *, raw_json: str | None = None) -> dict:
    """Validate ``payload`` (a parsed ``lcx:template`` JSON object) in place.

    Returns ``payload`` unchanged on success. Raises :class:`TemplateMetadataError`
    on a schema-version mismatch, an oversize payload, or any field outside the
    ref/instance-map/request-contract shape this module owns.
    """
    size_source = raw_json if raw_json is not None else json.dumps(payload)
    size = len(size_source.encode("utf-8"))
    _require(size <= MAX_METADATA_BYTES, f"template metadata exceeds {MAX_METADATA_BYTES} bytes")
    _require(isinstance(payload, dict), "template metadata must be an object")
    _require(
        set(payload) == {"schema_version", "template", "instances"},
        "template metadata has unknown top-level fields",
    )
    _require(payload.get("schema_version") == SCHEMA_VERSION, "unsupported schema_version")
    _validate_ref(payload["template"], field="template")
    instances = payload["instances"]
    _require(isinstance(instances, dict), "instances must be an object")
    assert isinstance(instances, dict)
    for slide_id, instance in instances.items():
        _require(isinstance(slide_id, str) and slide_id, "instances keys must be non-empty ids")
        _validate_instance(instance, field=f"instances[{slide_id}]")
    return payload
