"""Prompt construction for the U2 template compiler's writing-style profile.

``build_style_profile_prompt`` builds the messages a caller hands to
``config.writer_model`` (see ``ai/langgraph-routing-tools.md`` — prompts stay
isolated in their own module, not inline inside compile logic). It never
calls a model itself; the caller owns the invocation, the retry budget
(``TemplateBudget.reserve_model_call``), and turning the response into
:class:`~app.agent.deck_template_models.StyleRule` entries.

Only the selected title/body example strings and structural observations
(character counts, bullet/line counts) are included — never the source file,
the whole deck, or the candidate's full HTML — so the model designs no new
visual rule and sees no page it was not asked to profile (plan U2).
"""

from __future__ import annotations

from dataclasses import dataclass

from .deck_template_models import SlideContentRequest, StyleRule, TemplateInstanceRequest

STYLE_PROFILE_SYSTEM = """You observe writing style from short title/body examples.
You do not design new visual rules, colors, fonts, or layout. You do not invent
content. For each requested role, describe only what the examples show: whether
titles are noun phrases, sentences, or questions; language and formality level;
sentence-ending form; and, for body text, bullet parallelism and punctuation
habits. If an example set is empty or too short to support a claim, say so
instead of guessing. Never state a rule as observed unless a supplied example
shows it."""


@dataclass(frozen=True)
class RoleExample:
    """One observed example for a slot role, with its source page number."""

    role: str
    page: int
    text: str


def build_style_profile_prompt(
    examples: list[RoleExample],
) -> list[dict[str, str]]:
    """Chat messages profiling writing style from ``examples`` alone.

    Returns a plain ``[{"role": ..., "content": ...}]`` list — the same
    message shape ``config.writer_model`` (a LangChain chat model) accepts
    directly, so the caller can pass this straight to
    ``model.invoke(messages)`` or reserve it against a
    :class:`~app.agent.deck_template_models.TemplateBudget` first via
    ``TemplateBudget.reserve_model_call(prompt_text=...)``.
    """
    lines = [
        f"[{example.role} / page {example.page}] {example.text}" for example in examples
    ]
    body = (
        "Observed examples, one per line as `[role / page] text`:\n"
        + ("\n".join(lines) if lines else "(no examples supplied)")
        + "\n\nDescribe the writing style per role. Cite only these examples."
    )
    return [
        {"role": "system", "content": STYLE_PROFILE_SYSTEM},
        {"role": "user", "content": body},
    ]


def style_profile_prompt_text(examples: list[RoleExample]) -> str:
    """The prompt's text content, for token-budget reservation before a call."""
    return "\n".join(message["content"] for message in build_style_profile_prompt(examples))


CONTENT_WRITER_SYSTEM = """You write slide slot content for a locked presentation frame.
Use ONLY the facts and slot inputs given below as factual grounding; never invent a new
fact, statistic, or claim. Match the observed writing-style rules for voice — they
describe how this document's author writes, not a generic house style. Return plain
text only: no HTML, no markdown, no styling, and no slot keys beyond the ones
requested."""


def build_content_writer_prompt(
    request: SlideContentRequest,
    writing_style: list[StyleRule],
) -> list[dict[str, str]]:
    """Chat messages asking the writer model to rewrite ``request.slots``.

    ``writing_style`` is the archetype's observed style rules already
    filtered by the caller to the roles of the requested slots. Only
    ``request``'s own facts/slots and those rules are included — never the
    source HTML or the deck's house style (plan U3's isolation requirement).
    """
    style_lines = [
        f"- [{rule.role}] {rule.property}: {rule.value}" for rule in writing_style
    ] or ["(no observed style rules for these roles — write plainly)"]
    fact_lines = [f"- {fact.id}: {fact.text}" for fact in request.required_facts] or [
        "(no required facts)"
    ]
    slot_lines = [f"- {key}: {value}" for key, value in request.slots.items()]
    body = (
        "Writing-style rules:\n" + "\n".join(style_lines) + "\n\n"
        "Required facts:\n" + "\n".join(fact_lines) + "\n\n"
        "Slots to write (key: input):\n" + "\n".join(slot_lines) + "\n\n"
        f"Locale: {request.locale}. Return exactly these slot keys: "
        f"{sorted(request.slots)}."
    )
    return [
        {"role": "system", "content": CONTENT_WRITER_SYSTEM},
        {"role": "user", "content": body},
    ]


def content_writer_prompt_text(
    request: SlideContentRequest, writing_style: list[StyleRule]
) -> str:
    """The prompt's text content, for token-budget reservation before a call."""
    return "\n".join(
        message["content"] for message in build_content_writer_prompt(request, writing_style)
    )


JUDGE_SYSTEM = """You are a strict compliance judge for slide content. You are given the
ORIGINAL required facts and input slots (the only factual basis) separately from the
document's observed writing-style rules (voice basis only — never a source of new facts).
Judge ONLY the actual output text supplied below; it is the sole thing being graded.

For each required fact id, decide whether its meaning is preserved, missing, or
ambiguous in the output. For each role_rule_id, decide pass, fail, or ambiguous. For
every factual assertion in the output — ignore harmless connective phrases that assert
nothing — report its exact character span within that output slot's text, whether it is
grounded in the original facts/input slots, unsupported, contradictory, or ambiguous, and
cite up to 8 evidence references, each either an original input slot key or a required
fact id. Never invent an input slot or fact that was not given to you, and never treat a
self-reported fact_coverage map as evidence — judge the text itself."""


def build_judge_prompt(
    request: TemplateInstanceRequest,
    writing_style: list[StyleRule],
    output_slots: dict[str, list[str]],
) -> list[dict[str, str]]:
    """Chat messages asking the judge model to grade ``output_slots`` alone.

    ``request`` is the immutable writer-origin contract recovered from
    store history (never the current revision's possibly-edited metadata),
    ``writing_style`` is the archetype's observed rules for the requested
    roles, and ``output_slots`` is text read back from the actual current
    slide markup — never a model's self-reported result.
    """
    fact_lines = [f"- {fact.id}: {fact.text}" for fact in request.required_facts] or [
        "(no required facts)"
    ]
    input_lines = [
        f"- {key}: {' | '.join(runs)}" for key, runs in request.input_slots.items()
    ] or ["(no original input slots)"]
    style_lines = [
        f"- [role_rule_id={rule.role}:{rule.property}] {rule.role}: {rule.property}={rule.value}"
        for rule in writing_style
    ] or ["(no observed style rules for these roles)"]
    output_lines = [
        f"- {key}: {' | '.join(runs)}" for key, runs in output_slots.items()
    ] or ["(no output slots)"]
    body = (
        "Original required facts (factual basis):\n" + "\n".join(fact_lines) + "\n\n"
        "Original input slots (factual basis):\n" + "\n".join(input_lines) + "\n\n"
        "Writing-style rules (voice basis only, not facts):\n" + "\n".join(style_lines) + "\n\n"
        "Actual output slots to judge (the only thing being graded):\n"
        + "\n".join(output_lines)
        + "\n\n"
        f"Report fact_status for exactly these fact ids: {sorted(f.id for f in request.required_facts)}."
    )
    return [
        {"role": "system", "content": JUDGE_SYSTEM},
        {"role": "user", "content": body},
    ]


def judge_prompt_text(
    request: TemplateInstanceRequest,
    writing_style: list[StyleRule],
    output_slots: dict[str, list[str]],
) -> str:
    """The judge prompt's text content, for token-budget reservation before a call."""
    return "\n".join(
        message["content"]
        for message in build_judge_prompt(request, writing_style, output_slots)
    )
