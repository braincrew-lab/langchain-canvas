# Source-grounded slide templates

Three separate user intents touch an uploaded PDF/PPTX deck, and only one of
them uses the tools on this page:

| Intent | Tools |
| --- | --- |
| Reproduce the original file as-is | the existing full-conversion path (`clone_deck_template` / `open_pdf_as_slides`) |
| Edit an existing deck's content | the existing editing tools (`deck_editing.py`) |
| Reuse the original's page layout and writing style for a **new** topic/slide count | `inspect_deck_patterns` → `define_deck_template` → `write_deck_from_template` → `verify_template_deck` |

This page documents only the third path: `apps/server/app/agent/deck_template_tools.py`
and the modules it wires together (`deck_source_catalog.py`, `deck_templates.py`,
`deck_template_writer.py`, `deck_template_verification.py`, plus the SDK-side
`packages/canvas-py/src/langchain_canvas/deck/template_metadata.py`). The full
original-file `clone_deck_template` reproduction path is unchanged.

## The four tools

### `inspect_deck_patterns`

```python
inspect_deck_patterns(source: str, runtime: ToolRuntime,
                       cursor: str | None = None, page_limit: int = 50) -> dict
```

Read-only census of a `sources/*.pdf`/`*.pptx` upload. It never renders a page,
decodes an image, or calls a model — it groups pages by a stable layout
signature (box positions, role/object counts) and returns up to 12 groups
drawn only from the pages this call actually inspected. Pass the returned
`next_cursor` to inspect more pages; the cursor is pinned to the source's
sha256, so continuing after the source changed is rejected as `stale_source`.
Call this first to pick which page(s) to reuse as a template.

### `define_deck_template`

```python
define_deck_template(mode: Literal["prepare", "finalize"], runtime: ToolRuntime,
                      source=None, source_sha256=None, pages=None,
                      candidate_ref=None, bindings=None) -> dict
```

A two-call protocol that compiles selected pages into a reusable **template**,
never the full document:

1. **`mode="prepare"`** (`source`, `source_sha256`, `pages`) converts only the
   named pages — PDF pages through `pdf_source.extract_pdf_pages` +
   `pdf_deck.reconstruct_pdf_page` (a model call, budget permitting); PPTX
   pages through `deck/extract.py::extract_slides` + `deck/baseline.py::baseline_slide_html`
   (deterministic, no model call) — into an unresolved **candidate**. Every
   original text/image node is proposed as `variable` (rewritable content),
   `retain` (kept as-is: brand/legal/static), or left `unresolved`. The
   candidate is written create-only to `templates/<hash>.candidate.json` and
   only its ref plus a compact node/slot summary is returned — never the
   frame HTML.
2. **`mode="finalize"`** (`candidate_ref`, `bindings`) takes one explicit
   disposition per candidate node (see `NodeBinding` below) and, only when
   every node is classified and no unsupported native dependency or degraded
   PDF reconstruction remains, writes a `ready` template to
   `templates/<hash>.template.json`. A failed finalize leaves the candidate
   untouched and writes no ready manifest.

`NodeBinding` (one entry per prepare-time node, `archetype_id` + `node_id` always required):

| `disposition` | Additional fields | Meaning |
| --- | --- | --- |
| `variable` | `slot_key`, `role` (`title`\|`body`\|`caption`), `required` | This node becomes an editable slot in every generated instance. Only `text` nodes may be `variable` — a variable `image` binding is `unsupported_template`. |
| `retain` | `retain_reason` (`brand`\|`legal`\|`static`) | Node is kept byte-identical (e.g. a logo or fixed disclaimer) in every instance. |
| `omit` | — | Node is dropped from the frame. |

A ready template only supports `title`/`body`/`caption` writable slots (v1). Group
objects, SmartArt, native tables/charts, and pages with an unresolved
master/background dependency are **capability-rejected** — they can never
reach `ready`; see "Unsupported native objects" below.

### `write_deck_from_template`

```python
write_deck_from_template(template_ref: dict, destination: str, title: str,
                          slides: list[dict], runtime: ToolRuntime) -> dict
```

Fills a trusted `ready` template's archetypes into a brand-new deck. Each
entry in `slides` (`SlideContentRequest`) names an `archetype_id` from the
ready template, a `mode`, the slot text to write, and `required_facts` the
output must preserve:

- **`mode="verbatim"`** copies the requested text through unchanged — no model
  call, fully deterministic (the same template plus the same verbatim input
  always produces byte-identical canonical HTML).
- **`mode="rewrite"`** calls the configured writer model with only that
  archetype's observed writing-style rules, the requested slots, and
  `required_facts` as grounding — **never** the original source HTML and
  never the scratch-writer `DECK_STYLE` used by `write_slides`. A response
  with the wrong slot keys or embedded HTML/CSS is `invalid_model_output`;
  the writer retries the fill up to twice before giving up.

The locked archetype frame (its layout, CSS, and every non-slot/retained
node) is never altered by content — only the declared slot nodes are filled,
via the same `deck_editing.py::_replace_text` used for manual edits, so
rich-run style and topology stay identical. Overflowing content is never
truncated or shrunk; it is rejected as `template_capacity_exceeded` so the
caller can pick a higher-capacity archetype or shorten the wording itself.
All requested slides are generated, then the whole deck is written in one
`store.write` call — a single failed slide aborts the batch and nothing is
committed.

### `verify_template_deck`

```python
verify_template_deck(path: str, revision: str, runtime: ToolRuntime) -> dict
```

Verifies one `write_deck_from_template` output. It re-reads everything fresh
from the canvas store's commit history — never in-memory state — so a restart
does not change the result:

1. The requested output revision's actual slide markup (the only thing being
   graded).
2. The **first** writer-origin commit for the path — the immutable original
   request contract (facts, requested slot text, verbatim expectations). A
   later edit is compared against this original contract, not whatever the
   current revision's own metadata claims.
3. The pinned `ready` template the original contract names.

See "Reading verification results" below for the response shape.

## Candidate/ready lifecycle

```
prepare(source, pages) ──► candidate (unresolved nodes, not writable)
                                │
                     finalize(candidate_ref, bindings)
                                │
                                ▼
                          ready (writable by write_deck_from_template)
```

- A **candidate** is never accepted as writer input — `write_deck_from_template`
  only reads a `ready` artifact.
- Both stages write create-only, content-addressed paths
  (`templates/<hash>.candidate.json`, `templates/<hash>.template.json`), so a
  retried `prepare`/`finalize` call with identical inputs reads back the
  existing artifact instead of writing a duplicate.
- Every candidate/ready artifact is written under the fixed internal actor
  `deck-template-compiler-v1`. `finalize`/`write_deck_from_template`/`verify_template_deck`
  each read the artifact back only if its exact commit was written by that
  actor (verified against store history, never trusting the JSON body's own
  `status`/hash fields) — a generic `write`/human-save commit at the same
  path, or a forged JSON file with a matching hash, is never accepted as
  compiler or writer output.
- `finalize` re-checks the source's current sha256 against the hash pinned in
  the candidate; a source that changed since `prepare` fails with
  `stale_source`. Once a template is `ready`, it is immutable — a later
  source edit does not invalidate an already-compiled template, and reusing
  it never re-converts the source.

## Error codes

Every tool in this family returns `{status: "error", code, message, details, retryable}`
on failure, drawn from one closed set:

| Code | Meaning |
| --- | --- |
| `invalid_source` | The named source is missing, not a `sources/*.pdf`/`*.pptx` upload, or its bytes do not match the given `source_sha256`. |
| `stale_source` | The source's current bytes no longer match the hash pinned at `prepare`/`inspect_deck_patterns` cursor time. |
| `stale_template` | Reserved for a pinned-template staleness check (see `deck_templates.py`). |
| `ambiguous_slots` | A binding is missing, duplicate, targets an unknown node/slot key, or a request payload fails schema validation. |
| `unsupported_template` | A variable binding targets a non-text node, or a selected page has an unresolved native dependency or degraded PDF reconstruction. |
| `template_capacity_exceeded` | A candidate/ready/metadata payload exceeds its byte cap, or generated content overflows its archetype's slot budget. |
| `invalid_model_output` | A `rewrite` model response fails schema validation, uses the wrong slot keys, or embeds HTML/CSS, even after retries. |
| `destination_exists` | The requested output path already exists, or was created concurrently between the pre-check and the commit. |
| `verification_failed` | An artifact reference fails the compiler/writer-origin trust check, or `verify_template_deck` cannot recover the original contract or pinned template. |
| `resource_budget_exceeded` | The shared cooperative compile/write budget (page census, render/reconstruction stages, model call/token counts) was exhausted. |

`retryable` is `true` only for `resource_budget_exceeded`. The SDK PPTX
exporter raises a distinct, non-tool-result error, `unsupported_template_export`
— see "Export" below.

## Unsupported native objects

v1 templates support only editable text, simple shapes, and real original
images that a representative page can fully express through HTML/CSS. The
following native objects are detected by the source census
(`packages/canvas-py/src/langchain_canvas/deck/source_inventory.py`) before
extraction and, if present on a selected page, permanently block that page
from reaching `ready` at `finalize` time:

- Group objects (`group`)
- SmartArt (`smartart`)
- Native tables (`native_table`)
- Native charts (`chart`)
- An unresolved master/background dependency (`master_background`)

A page with any of these issues fails closed — it is never partially
represented, never silently dropped, and never replaced with a rasterized
image of the original page to fake success.

## Raw facts vs. writing style

A ready archetype's `writing_style` field carries **only** style
observations (title noun-phrase vs. sentence form, language, register,
bullet parallelism, punctuation) with an `origin` of `observed`, `inferred`,
`user_override`, or `unknown` — evidence for a style claim is a `(page,
snippet)` pair from the actual source, and an inferred rule is never silently
promoted to `observed` without one.

A generated instance's factual content comes from exactly one place: the
`SlideContentRequest.required_facts` and `slots` the caller supplied to
`write_deck_from_template`. The writer model, when invoked for `rewrite`,
receives the writing-style rules and the requested facts/slots — never the
source page's HTML or business text. `verify_template_deck`'s runtime judge
enforces the same separation: source role examples are style evidence only,
and every factual claim in the output must trace back to the original
`input_slots`/`required_facts`, never to the writer model's own
self-reported `fact_coverage` or a matching content hash.

## Reading verification results

```python
{
  "complete": bool,
  "output_revision": str,
  "template_ref": {...},
  "checked_slide_ids": [str, ...],
  "visual_fidelity": {"status": ..., "issues": [...]},
  "content": {"status": ..., "issues": [...]},
  "writing_style": {"status": ..., "issues": [...]},
  "issues": [...],
  "warnings": [...],
}
```

Each dimension's `status` is one of:

| Status | Meaning |
| --- | --- |
| `verified` | Positively confirmed — every check for this dimension passed. |
| `failed` | A concrete violation was found (missing/extra DOM node, missing pinned asset, verbatim text mismatch, a judge-flagged missing/unsupported/contradictory fact or claim). |
| `degraded` | Not a hard failure, but not fully proven either — an unresolved original font, or an unmeasurable geometry backend. Only ever applies to `visual_fidelity`. |
| `not_checked` | The dimension could not be evaluated at all (missing original input slots, an unavailable or malformed runtime judge, an ambiguous judge finding). Never treated as a pass. |

`complete=True` requires all three dimensions to be `verified` — a
`degraded` or `not_checked` result on any dimension, or a saved deck with no
verification run at all, is never reported as fully verified. A structural
`failed` finding (missing/extra node, verbatim mismatch) is never overridden
by the runtime judge's opinion; the judge only contributes to `content`/`writing_style`
for `rewrite` slides, and only after the structural checks already passed.

## Additive canonical metadata

A deck produced by `write_deck_from_template` carries an optional
`<meta name="lcx:template" content="...">` tag in its HTML — see
[the wire protocol document](02-protocol.md#additive-template-provenance-metadata)
for its schema. A deck without this tag (every deck produced before this
feature, and every deck produced by the existing reproduction/editing paths)
behaves exactly as before; nothing about the existing wire protocol,
`Deck` parsing, or rendering changes for those decks.

## Scope notes

- This feature adds no new database, LangGraph node, provider, API endpoint,
  or wire streaming event. Templates are ordinary content-addressed JSON
  files in the same `CanvasStore` every other artifact uses.
- Export: the app's `EditableDeckPptxExporter` supports exporting a
  template-produced deck to a native-blank PPTX. The SDK's own
  `DeckPptxExporter.export` fails closed with `unsupported_template_export`
  when a deck carries `lcx:template` metadata — it never attempts a
  best-effort ordinal-patch export of a source-grounded deck.
- Real customer-file fidelity (actual installed fonts, non-synthetic page
  layouts) is `UNVERIFIED` beyond the synthetic fixtures this feature ships
  with; this is a fidelity confirmation gap, not a blocker for the synthetic
  implementation.
