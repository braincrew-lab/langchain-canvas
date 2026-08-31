"""Request/ref/schema contracts for source-grounded slide templates.

Task 1 laid down the request/ref/manifest shapes that
``deck_template_writer.py::instantiate_archetype`` and
``langchain_canvas.deck.template_metadata`` use to build and validate the
neutral ``lcx:template`` metadata (see plan U3/U4). Task 3 (this addition)
owns the U2 compiler-side contract: the ``prepare``/``finalize`` request
payloads, the ``NodeBinding`` discriminated union, the compiled
``candidate``/``ready`` manifest shape (:class:`CompiledTemplateManifest`),
and :class:`TemplateBudget`, the cooperative consumed-work/admission budget
shared by every model-touching stage on the template compile path. Later
tasks add the runtime judge schema.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Annotated, Callable, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator, field_validator

MAX_FACTS_PER_INSTANCE = 32
MAX_FACT_TEXT_CHARS = 1000
MAX_SLOTS_PER_INSTANCE = 64
MAX_SLOT_TEXT_CHARS = 4000
MAX_METADATA_BYTES = 256 * 1024

# U2 compiler-side bounds (plan "동일 도구의 정확한 2회 프로토콜").
MAX_TEMPLATE_PAGES = 8
MAX_PAGE_NUMBER = 500
MAX_BINDINGS = MAX_TEMPLATE_PAGES * 500  # 8 pages x <=500 objects/page census cap
MAX_CANDIDATE_JSON_BYTES = 2 * 1024 * 1024

_ShortId = Annotated[str, Field(min_length=1, max_length=200)]
_FactText = Annotated[str, Field(min_length=1, max_length=MAX_FACT_TEXT_CHARS)]
_SlotText = Annotated[str, Field(max_length=MAX_SLOT_TEXT_CHARS)]
_Path512 = Annotated[str, Field(min_length=1, max_length=512)]
_Revision128 = Annotated[str, Field(min_length=1, max_length=128)]
_Sha256Hex = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
_Id64 = Annotated[str, Field(min_length=1, max_length=64)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ArtifactRef(_Strict):
    """A pinned artifact: a store path plus the revision/hash that named it."""

    path: _ShortId
    revision: _ShortId
    sha256: _ShortId


class SourceRef(_Strict):
    """A pinned original-source page: same shape as :class:`ArtifactRef`."""

    path: _ShortId
    revision: _ShortId
    sha256: _ShortId


class Fact(_Strict):
    """One required fact the writer must preserve or place in an output slot."""

    id: _ShortId
    text: _FactText


_RichRunList = Annotated[
    list[_SlotText], Field(min_length=1, max_length=MAX_SLOTS_PER_INSTANCE)
]
# A single slot's content: exact text, or ordered rich-run strings when the
# frame's slot node holds more than one styled run (task 4, plan U3).
_SlotValue = _SlotText | _RichRunList


class SlideContentRequest(_Strict):
    """One requested output slide: which archetype, which content, which mode.

    ``verbatim`` copies ``slots`` text through unchanged (no model call).
    ``rewrite`` uses ``slots``/``required_facts`` as the model's only
    factual grounding. Sizes are bounded per the plan's per-instance budget.
    """

    archetype_id: _ShortId
    mode: Literal["verbatim", "rewrite"]
    slots: Annotated[
        dict[_ShortId, _SlotValue], Field(max_length=MAX_SLOTS_PER_INSTANCE)
    ]
    required_facts: Annotated[list[Fact], Field(max_length=MAX_FACTS_PER_INSTANCE)] = []
    locale: _ShortId = "ko"


class TemplateInstanceRequest(_Strict):
    """The immutable original request contract stored with a writer instance.

    ``input_slots`` is required for both modes; ``verbatim_expectations`` is
    required for ``verbatim`` and omitted for ``rewrite`` (see plan U4).
    """

    mode: Literal["verbatim", "rewrite"]
    locale: _ShortId
    required_facts: Annotated[list[Fact], Field(max_length=MAX_FACTS_PER_INSTANCE)] = []
    input_slots: Annotated[
        dict[_ShortId, list[_SlotText]], Field(max_length=MAX_SLOTS_PER_INSTANCE)
    ]
    verbatim_expectations: Annotated[
        dict[_ShortId, list[_SlotText]] | None,
        Field(max_length=MAX_SLOTS_PER_INSTANCE),
    ] = None


class TemplateInstance(_Strict):
    """One output slide's provenance: archetype, source page, and its request."""

    archetype_id: _ShortId
    source_page: int = Field(ge=0)
    slot_content_sha256: _ShortId
    request: TemplateInstanceRequest
    fact_to_slot: Annotated[
        dict[_ShortId, _ShortId], Field(max_length=MAX_FACTS_PER_INSTANCE)
    ] = {}


class TemplateManifest(_Strict):
    """The full ``lcx:template`` metadata payload — schema version 1."""

    schema_version: Literal[1] = 1
    template: ArtifactRef
    instances: dict[_ShortId, TemplateInstance]


class SlotContentResult(_Strict):
    """One archetype instance's slot fill, from a model or a verbatim copy.

    Maps each slot key to its exact text or ordered rich-run replacement —
    never HTML, CSS, or a model-selected asset path (plan U3).
    ``fact_coverage`` records which output slot each required fact landed
    in; it is evidence of where a fact *was written*, never proof that
    placement preserved meaning (U5's runtime judge owns that claim).
    """

    archetype_id: _ShortId
    mode: Literal["verbatim", "rewrite"]
    slots: Annotated[
        dict[_ShortId, _SlotValue], Field(max_length=MAX_SLOTS_PER_INSTANCE)
    ]
    fact_coverage: Annotated[
        dict[_ShortId, _ShortId], Field(max_length=MAX_FACTS_PER_INSTANCE)
    ] = {}

    @field_validator("slots")
    @classmethod
    def _no_html_markup(
        cls, slots: dict[str, str | list[str]]
    ) -> dict[str, str | list[str]]:
        for key, value in slots.items():
            runs = value if isinstance(value, list) else [value]
            for text in runs:
                if "<" in text or ">" in text:
                    raise ValueError(f"slot {key!r} must not contain HTML markup")
        return slots


# --- U2: prepare/finalize request payloads (task 3) --------------------------------


class PrepareRequest(_Strict):
    """``define_deck_template(mode='prepare')`` payload — one source, k pages."""

    mode: Literal["prepare"]
    source: _Path512
    source_sha256: _Sha256Hex
    pages: Annotated[list[int], Field(min_length=1, max_length=MAX_TEMPLATE_PAGES)]

    @field_validator("pages")
    @classmethod
    def _pages_unique_and_in_range(cls, pages: list[int]) -> list[int]:
        if len(set(pages)) != len(pages):
            raise ValueError("pages must not contain duplicates")
        if any(number < 1 or number > MAX_PAGE_NUMBER for number in pages):
            raise ValueError(f"pages must be in 1..{MAX_PAGE_NUMBER}")
        return pages


class VariableBinding(_Strict):
    """A candidate node the writer must fill with new content at a named slot."""

    archetype_id: _Id64
    node_id: _Id64
    disposition: Literal["variable"]
    slot_key: _Id64
    role: Literal["title", "body", "caption"]
    required: bool


class RetainBinding(_Strict):
    """A candidate node kept verbatim from the source (logo, legal line, ...)."""

    archetype_id: _Id64
    node_id: _Id64
    disposition: Literal["retain"]
    retain_reason: Literal["brand", "legal", "static"]


class OmitBinding(_Strict):
    """A candidate node dropped from the ready template entirely."""

    archetype_id: _Id64
    node_id: _Id64
    disposition: Literal["omit"]


NodeBinding = Annotated[
    VariableBinding | RetainBinding | OmitBinding,
    Field(discriminator="disposition"),
]


class FinalizeRequest(_Strict):
    """``define_deck_template(mode='finalize')`` payload — a trusted candidate + bindings."""

    mode: Literal["finalize"]
    candidate_ref: ArtifactRef
    bindings: Annotated[list[NodeBinding], Field(min_length=1, max_length=MAX_BINDINGS)]


# --- U2: compiled candidate/ready manifest (task 3) ---------------------------------


class AssetRef(_Strict):
    """A pinned, content-addressed asset the compiler already wrote and hashed."""

    path: _Path512
    revision: _Revision128
    sha256: _Sha256Hex


class StyleEvidence(_Strict):
    """One observed source snippet that justifies a :class:`StyleRule`."""

    page: int = Field(ge=1, le=MAX_PAGE_NUMBER)
    snippet: Annotated[str, Field(max_length=500)]


class StyleRule(_Strict):
    """One writing-style constraint, with its evidentiary origin.

    ``origin='observed'`` requires at least one :class:`StyleEvidence` entry;
    an inferred rule with no example is never promoted to ``observed``.
    """

    role: _Id64
    property: _Id64
    value: str | float | bool
    origin: Literal["observed", "inferred", "user_override", "unknown"]
    evidence: Annotated[list[StyleEvidence], Field(max_length=16)] = []


class StyleProfileResponse(_Strict):
    """The style-profile model call's structured response (task 3's ticket #1 fix).

    Wraps a plain ``rules`` list so ``model.with_structured_output`` has a
    single schema to target; the caller stores ``rules`` on the archetype
    unchanged (or ``[]`` on any budget/transport failure — see
    ``deck_templates.py::_profile_writing_style``).
    """

    rules: Annotated[list[StyleRule], Field(max_length=64)] = []


class Slot(_Strict):
    """One candidate node proposed as a writer-fillable slot."""

    key: _Id64
    node_id: _Id64
    node_type: Literal["text", "image"]
    role: Literal["title", "body", "caption"]
    required: bool
    rich_run_count: int = Field(ge=0)
    budget: dict[str, int] = {}
    observed_lengths: dict[str, int] = {}
    disposition: Literal["variable", "retain", "omit"] = "variable"


class StaticNode(_Strict):
    """One candidate node proposed to stay fixed (retained or omitted).

    ``node_type`` includes ``"shape"`` (drawn rectangles/lines/ellipses) in
    addition to ``"text"``/``"image"`` — v1 writable slots are text-only, so
    every image and drawn shape defaults to a static node.
    """

    node_id: _Id64
    node_type: Literal["text", "image", "shape"]
    disposition: Literal["retain", "omit"] = "retain"
    retain_reason: Literal["brand", "legal", "static"] | None = None


class Archetype(_Strict):
    """One compiled source page: its frame, proposed slots, and proof."""

    id: _Id64
    source_page: int = Field(ge=1, le=MAX_PAGE_NUMBER)
    frame_html: str
    style_css: str
    slots: list[Slot] = []
    static_nodes: list[StaticNode] = []
    assets: list[AssetRef] = []
    protected_layout: dict = {}
    writing_style: list[StyleRule] = []
    proof: dict = {}


class CompiledTemplateManifest(_Strict):
    """The ``templates/<hash>.{candidate,template}.json`` artifact body.

    ``status='candidate'`` is the ``prepare`` output — unresolved,
    non-writable, and rejected as writer input. ``status='ready'`` is the
    ``finalize`` output, produced only once every node in every archetype has
    an explicit disposition and the capability/reconstruction gate passes.
    """

    schema_version: Literal[1] = 1
    status: Literal["candidate", "ready"]
    source: SourceRef
    selected_pages: Annotated[list[int], Field(min_length=1, max_length=MAX_TEMPLATE_PAGES)]
    ratio: _Id64
    archetypes: list[Archetype]


# --- U2: cooperative consumed-work/admission budget (task 3) -----------------------


class BudgetExceededError(RuntimeError):
    """A stage or model-call admission check failed — tool code `resource_budget_exceeded`."""

    code: str = "resource_budget_exceeded"


@dataclass
class TemplateBudget:
    """A cooperative, per-run consumed-work/admission budget.

    Bounds elapsed queue+execution time (``run_stage``, checked before AND
    after each stage) and model usage (``reserve_model_call``, checked
    before every call and charged against a shared cap). This is a
    **cooperative** budget: it never interrupts a running stage or an
    outstanding model call — ``render.py``'s ``Future.result`` has no
    timeout and a model call may run to its own (600s) deadline. What it
    guarantees is that a stage or call that finishes *after* the window has
    closed has its result discarded and no further stage, model call, or
    publication is allowed to start from this budget instance.

    ``clock`` is injectable so tests can advance time deterministically
    without sleeping (see ``test_deck_templates.py``'s fake clock).
    """

    clock: Callable[[], float] = time.monotonic
    stage_budget_seconds: float = 120.0
    max_model_attempts: int = 24
    max_total_tokens: int = 64_000
    max_response_tokens: int = 8_000

    _start: float = field(init=False)
    _model_attempts: int = field(default=0, init=False)
    _total_tokens: int = field(default=0, init=False)
    _exceeded: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        self._start = self.clock()

    @property
    def elapsed_seconds(self) -> float:
        return self.clock() - self._start

    @property
    def exceeded(self) -> bool:
        return self._exceeded or self.elapsed_seconds > self.stage_budget_seconds

    def consumed_state(self) -> dict[str, float | int]:
        """A snapshot a trusted candidate can carry forward into ``finalize``."""
        return {
            "elapsed_seconds": self.elapsed_seconds,
            "model_attempts": self._model_attempts,
            "total_tokens": self._total_tokens,
        }

    @classmethod
    def resume(
        cls,
        consumed: dict[str, float | int] | None,
        *,
        clock: Callable[[], float] = time.monotonic,
        **overrides: float | int,
    ) -> "TemplateBudget":
        """A fresh budget seeded with a prior stage's consumption.

        ``prepare_template``'s consumption is preserved on the trusted
        candidate so ``finalize_template`` inherits it (same 120s window,
        same admission caps) rather than getting a second full budget. A
        write/verify budget is a fresh instance instead (no ``resume``).
        """
        budget = cls(clock=clock, **overrides)  # type: ignore[arg-type]
        if consumed:
            budget._start -= float(consumed.get("elapsed_seconds", 0.0))
            budget._model_attempts = int(consumed.get("model_attempts", 0))
            budget._total_tokens = int(consumed.get("total_tokens", 0))
            if budget.exceeded:
                budget._exceeded = True
        return budget

    def _check(self, *, stage: str) -> None:
        if self.exceeded:
            self._exceeded = True
            raise BudgetExceededError(f"{stage}: cooperative stage budget exceeded")

    @contextmanager
    def run_stage(self, name: str) -> Iterator[None]:
        """Bound one stage: checked before AND after — see class docstring.

        A stage that starts within budget but finishes after it closed has
        its result discarded (the caller's ``with`` body raises
        :class:`BudgetExceededError` on exit) and this budget is marked
        exceeded, so no later stage on the same instance can proceed.
        """
        self._check(stage=name)
        yield
        if self.exceeded:
            self._exceeded = True
            raise BudgetExceededError(
                f"{name}: finished after the 120s cooperative budget window closed"
            )

    def reserve_model_call(self, *, prompt_text: str, max_response_tokens: int) -> None:
        """Admission check + charge for one model attempt.

        Reserves the prompt and the maximum possible response *before* the
        call is made — never charges only the actual response, since a
        hung/oversized response should not be freely retryable. Token counts
        use UTF-8 byte length as a conservative (over-)estimate when no
        tokenizer is available, per the plan's fixed v1 policy.
        """
        self._check(stage="model_call_admission")
        if self._model_attempts >= self.max_model_attempts:
            self._exceeded = True
            raise BudgetExceededError("model attempt cap exceeded")
        if max_response_tokens > self.max_response_tokens:
            raise BudgetExceededError("single-response token cap exceeded")
        prompt_tokens = len(prompt_text.encode("utf-8"))
        if self._total_tokens + prompt_tokens + max_response_tokens > self.max_total_tokens:
            self._exceeded = True
            raise BudgetExceededError("total token cap exceeded")
        self._model_attempts += 1
        self._total_tokens += prompt_tokens + max_response_tokens


# --- U5: runtime judge result (task 5) ----------------------------------------------

MAX_CLAIMS_PER_INSTANCE = 64
MAX_EVIDENCE_PER_CLAIM = 8


class ClaimEvidence(_Strict):
    """One evidence pointer for a claim: either an original input slot or a
    required fact id — never a new fact the judge itself introduces."""

    input_slot: _Id64 | None = None
    fact_id: _Id64 | None = None

    @model_validator(mode="after")
    def _exactly_one_reference(self) -> "ClaimEvidence":
        if (self.input_slot is None) == (self.fact_id is None):
            raise ValueError("evidence must reference exactly one of input_slot or fact_id")
        return self


class RuntimeJudgeClaim(_Strict):
    """One factual assertion the judge found in the actual output text.

    ``start``/``end`` are character offsets into the output slot's text —
    the caller validates they fall within that text's real bounds; a claim
    whose span the judge invented is a malformed response, not evidence.
    """

    slot_key: _Id64
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    status: Literal["grounded", "unsupported", "contradictory", "ambiguous"]
    evidence: Annotated[list[ClaimEvidence], Field(max_length=MAX_EVIDENCE_PER_CLAIM)] = []

    @model_validator(mode="after")
    def _end_not_before_start(self) -> "RuntimeJudgeClaim":
        if self.end < self.start:
            raise ValueError("claim end must be >= start")
        return self


class RuntimeJudgeResult(_Strict):
    """The runtime judge's per-instance content/voice verdict (plan U5).

    Independent of the writer model's own ``fact_coverage`` self-report —
    this is a separate model call over the archetype's observed
    ``writing_style`` (voice basis) and the original ``required_facts``/
    ``input_slots`` (the only factual basis), judging only the actual
    output text. ``fact_status`` covers the request's required facts;
    ``role_rule_status`` covers the request's observed style rules
    (keyed by ``"{role}:{property}"`` — see
    ``deck_template_verification.py::_role_rule_key``); ``claims`` covers
    every factual assertion in the output, not only the ones tied to a
    required fact. Harmless connective phrases are never claims.
    """

    fact_status: dict[_Id64, Literal["preserved", "missing", "ambiguous"]] = {}
    role_rule_status: dict[_Id64, Literal["pass", "fail", "ambiguous"]] = {}
    claims: Annotated[list[RuntimeJudgeClaim], Field(max_length=MAX_CLAIMS_PER_INSTANCE)] = []
