<!-- AGENTS.md bridge (optional): uncomment to unify cross-tool agent guidance
     @AGENTS.md
-->
<!-- omb:setup v2 | 2026-04-18 -->

# oh-my-braincrew

## WHY
Multi-domain Claude Code harness orchestrating domain sub-agents across Python/FastAPI, React/TypeScript, Electron, LangGraph, and Postgres/Redis. Hooks, skills, and agents are the primary deliverable.

## WHAT
- `apps/api/` — FastAPI backend (Python)
- `apps/web/` — React frontend (TypeScript)
- `apps/ai/` — LangGraph AI service (Python)
- `src/hook/` — `oh-my-braincrew` CLI / hook handler package
- `infra/` — docker-compose, Terraform
- `tests/` — hook tests
- `.claude/` — harness config (agents, skills, rules, hooks)
- `.omb/` — working dirs (plans, todo, interviews, db)
- `docs/` — human documentation
- `docs/wiki/` — project blueprint (machine-consumable)
- `.claude/rules/` — detailed conventions (progressive disclosure)

## HOW
| Purpose   | Command |
|-----------|---------|
| Dev       | `turbo dev` (web) / `cd apps/api && uvicorn api.main:app --reload` / `cd apps/ai && langgraph dev` |
| Test      | `uv run pytest tests/ -v --timeout=10 --cov=src --cov-report=term-missing && cd apps/api && uv run pytest tests/ -v --timeout=10 && cd ../ai && uv run pytest tests/ -v --timeout=10 && cd ../web && npx vitest run` |
| Lint      | `ruff check apps/api/ apps/ai/ && cd apps/web && npx eslint .` |
| Typecheck | `pyright apps/api/ apps/ai/ && cd apps/web && npx tsc --noEmit` |
| Build     | `turbo build` (web) / `docker build` (api, ai) |

## HARD Rules
Universal (positive form):
- [HARD] Load secrets, tokens, and API keys from environment variables only
- [HARD] Claim completion only after fresh verification evidence (run proof → read output → claim)
- [HARD] Submit work through a separate review pass before merge
- [HARD] Validate inputs at every system boundary (API, IPC, CLI, file I/O)
- [HARD] Write user-facing documents (PR body, commit body, docs, wiki) in the language set by `OMB_DOCUMENTATION_LANGUAGE` (default `en`); keep code, identifiers, file paths, and PR/commit **titles** in English

## Coding Principles

Directional guidance — HARD Rules win on conflict. Details: `.claude/rules/common/coding-principles.md`.

- **Think Before Coding** — "State the problem and success criterion before writing a single line."
- **Simplicity First** — "The simplest solution that works — not the most general one."
- **Surgical Changes** — "Every line in the diff must trace back to a plan requirement."
- **Goal-Driven Execution** — "Every step has a verifiable success signal — run it before claiming done."

Project-specific:
- [HARD] Write all prompts, rules, skills, hooks, code comments, commit messages, sub-agent narrative report prose, and sub-agent result envelopes in English.
  Conversational explanation prose follows `OMB_DOCUMENTATION_LANGUAGE` — see `.claude/rules/common/explanation-style.md`.
  Exception: quoted example text that demonstrates user-facing output may be written in `OMB_DOCUMENTATION_LANGUAGE`. Instructional and normative text stays English.
- [HARD] Spawn sub-agents only from the main session via `Agent()` — sub-agents never call `Agent()`
- [HARD] End every sub-agent response with an `<omb>STATUS</omb>` tag and `result` envelope (DONE / RETRY / BLOCKED)
- [HARD] Implement only what the design specifies; flag scope changes instead of expanding silently
- [HARD] Cite only durable, committed evidence in SoT documents (`docs/**`, `CLAUDE.md`, `.claude/rules/**`) and delete superseded text rather than deprecating it — exemptions are ADRs, externally-consumed versioned API docs, and CHANGELOG. Enforced by `@wiki-reviewer` REJECT conditions and `tests/harness/test_rules_contract.py`; full contract in `.claude/rules/common/sot-authoring.md`.

## Explanation Contract (summary)
User-facing explanations use noun-phrase section headings, self-identifying references,
importance-ordered completion reports, the option/recommendation/impact set, and the
comprehension skeleton for readers who did not write the code.
Full text: `.claude/rules/common/explanation-style.md`.

## Gotchas / Non-obvious Patterns
<!-- User-editable. Record project quirks Claude cannot infer from the code.
     Good entries:
       - "auth middleware must run before body parser (legacy reason X)"
       - "we use snake_case for DB columns but camelCase in API responses"
     Add new items via direct edit. Longer lessons → `omb:wiki update`. -->

## Gold Standard References
<!-- User-editable. Point to exemplar files whose style should be copied.
     The agent learns patterns better from one concrete file than from paragraphs of prose.
     Example entries:
       - `src/api/routers/health.py` — router structure and error handling
       - `apps/web/src/components/ui/button.tsx` — component convention -->

## Reference Index (progressive disclosure)
<!-- Load only when relevant to the current task.
     Rows with "(if present)" are emitted only when the referenced path exists at generation time. -->

| Topic | Path |
|-------|------|
| Rules root index (progressive disclosure entry) | `.claude/rules/INDEX.md` |
| Common rules manifest | `.claude/rules/common/INDEX.md` |
| Blueprint wiki | `docs/wiki/index.md` |
| Feedback loop | `.claude/skills/omb-feedback/SKILL.md` |
| Wiki contract (frozen OKF snapshot, schemas, templates, authoring rules) | `.claude/skills/omb-wiki/` (`rules/okf-v0.1-snapshot.md`, `schemas/domains.yml`, `templates/`, `rules/`) |
| Architecture docs | `docs/oh-my-braincrew/` |
| Explanation contract (user-facing prose) | `.claude/rules/common/explanation-style.md` |
| SoT authoring contract (durable evidence, hard delete) | `.claude/rules/common/sot-authoring.md` |

## Memory & Lesson Capture
- Facts / preferences / decisions → auto-memory (already enforced by system; do not duplicate here)
- Lesson learned / recurring gotcha → `omb:wiki update`
- Information lookup → `omb:wiki read <topic>`
