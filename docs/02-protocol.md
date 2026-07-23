# Canvas Wire Protocol — v1

The protocol is the contract between a LangChain agent (Python) and a React
canvas (TypeScript). Everything else in this repo is an implementation detail;
this document is the source of truth. The Python types in
`langchain_canvas.protocol` and the TypeScript types in `@braincrew-lab/langchain-canvas`
are hand-mirrored from the definitions below and must stay in lockstep.

## Design goals

1. **Artifacts are emitted, never parsed.** The agent opens a canvas by calling
   a tool, not by writing magic tokens into its prose. Every canvas mutation is
   a schema-validated event.
2. **A `type` string selects a renderer.** The backend only ever ships data
   (`{ type, data }`); it never ships JSX. The frontend owns a registry that
   maps `type → React component`.
3. **A stable `id` is the reconciliation primitive.** Streaming updates and
   explicit revisions both key off the same `id`. Same `id` → mutate in place;
   new `id` → new artifact.
4. **Two streaming layers.** Chat tokens and artifact mutations travel on the
   same wire but are distinct event families, so the transcript and the canvas
   update independently.

## Transport

A single endpoint streams **Server-Sent Events** (`text/event-stream`):

```
POST /api/chat
  body: { thread_id: string, message: string }
  ->    text/event-stream, one JSON envelope per `data:` line, terminated by a
        `done` event.
```

SSE is the right default: it is one-directional (server → client), survives
proxies, auto-reconnects, and needs no handshake. Swap in WebSocket only if you
add client → server mid-stream signals (e.g. live co-editing).

## Envelope

Every line is one JSON object discriminated by `type`.

### Chat family — drives the conversation transcript

| `type`           | payload                          | meaning                          |
| ---------------- | -------------------------------- | -------------------------------- |
| `message.delta`  | `{ messageId, text }`            | one assistant token chunk        |
| `message.end`    | `{ messageId }`                  | assistant message complete       |
| `tool.start`     | `{ toolCallId, name }`           | a tool began executing           |
| `tool.end`       | `{ toolCallId, ok }`             | a tool finished (ok / errored)   |

### Canvas family — drives the canvas panel

| `type`            | payload                         | reconciliation effect                                   |
| ----------------- | ------------------------------- | ------------------------------------------------------- |
| `canvas.create`   | `{ artifact }`                  | register artifact, open panel, focus it                 |
| `canvas.append`   | `{ id, path, text }`            | append `text` to the string at `data.<path>`            |
| `canvas.patch`    | `{ id, patch }`                 | JSON-merge-patch `patch` into `data`                    |
| `canvas.replace`  | `{ id, artifact }`              | snapshot as a new version, bump `version`               |
| `canvas.status`   | `{ id, status }`                | set `streaming` / `complete` / `error`                  |
| `canvas.close`    | `{ id }`                        | mark closed (kept in history)                           |

### Control family

| `type`    | payload            | meaning                        |
| --------- | ------------------ | ------------------------------ |
| `error`   | `{ message }`      | run-level failure              |
| `done`    | `{}`               | stream finished, close the SSE |

## Artifact shape

```ts
type Artifact<TData = unknown> = {
  id: string;          // stable identity — the reconciliation key
  type: string;        // registry key: "document" | "chart" | ...
  title: string;       // shown in the canvas header / tab
  version: number;     // 1-based; bumped on every `canvas.replace`
  status: "streaming" | "complete" | "error";
  data: TData;         // type-specific payload, rendered by the matched component
  meta?: Record<string, unknown>;
};
```

### Built-in artifact data shapes

```ts
// type: "html" — the base substrate, rendered in a sandboxed iframe
type HtmlData = { html: string };

// type: "document"
type DocumentData = { format: "markdown"; content: string };

// type: "chart"
type ChartData = {
  chart: "line" | "bar" | "area" | "pie";
  rows: Array<Record<string, string | number>>;  // tidy/long-form rows
  xKey: string;                                   // category / x-axis field
  series: Array<{ key: string; label?: string; color?: string }>;
  options?: { stacked?: boolean; yLabel?: string };
};

// type: "table"
type TableData = {
  columns: Array<{ key: string; label?: string; align?: "left" | "right" | "center" }>;
  rows: Array<Record<string, string | number>>;
};

// type: "slides"
type SlidesData = { slides: Slide[] };
type Slide = {
  layout?: "title" | "content" | "section" | "image" | "two-column" | "blank";
  title?: string;
  subtitle?: string;
  bullets?: string[];
  bullets2?: string[];   // right column for "two-column"
  image?: string;        // data: or https URL, for "image"
  background?: string;   // hex
  textColor?: string;    // hex
  notes?: string;        // speaker notes → exported to the .pptx notes pane
  elements?: SlideElement[]; // free-positioned items for the "blank" layout
};
```

New artifact types are added by (1) defining a data shape here, (2) mirroring it
in both `protocol` modules, and (3) registering a renderer on the frontend. No
change to the transport or the reconciler is needed.

## What to emit per type — copy-paste examples

Each artifact renders through the component its `type` selects. **Ship structured
data for the type you want** — do not wrap a chart/table/document in `html` and
hope; the HTML renderer can't give you a spreadsheet grid or a slide deck. Every
example below is a complete `canvas.create` envelope (one `data:` SSE line).

### `html` — a web page

```json
{ "type": "canvas.create", "artifact": {
  "id": "page-1", "type": "html", "title": "Landing page", "version": 1,
  "status": "complete",
  "data": { "html": "<!doctype html><html><body><h1>Hi</h1></body></html>" }
} }
```

### `document` — a Word-style document (markdown)

```json
{ "type": "canvas.create", "artifact": {
  "id": "doc-1", "type": "document", "title": "Q3 report", "version": 1,
  "status": "complete",
  "data": { "format": "markdown", "content": "# Q3 report\n\n**Revenue** grew 12%.\n\n- point one\n- point two" }
} }
```

Stream the body token-by-token with `canvas.append` at path `content`:
`{ "type": "canvas.append", "id": "doc-1", "path": "content", "text": " more…" }`.

### `slides` — a PowerPoint deck

```json
{ "type": "canvas.create", "artifact": {
  "id": "deck-1", "type": "slides", "title": "Pitch", "version": 1,
  "status": "complete",
  "data": { "slides": [
    { "layout": "title",   "title": "AI for business", "subtitle": "2026 outlook" },
    { "layout": "content", "title": "Why now", "bullets": ["Cheaper models", "Better tools", "Real ROI"] },
    { "layout": "image",   "title": "Architecture", "image": "https://…/diagram.png", "notes": "walk through the flow" }
  ] }
} }
```

### `table` — an Excel-style grid

```json
{ "type": "canvas.create", "artifact": {
  "id": "tbl-1", "type": "table", "title": "Sales", "version": 1,
  "status": "complete",
  "data": {
    "columns": [
      { "key": "region", "label": "Region" },
      { "key": "q3", "label": "Q3", "align": "right" }
    ],
    "rows": [ { "region": "APAC", "q3": 120 }, { "region": "EMEA", "q3": 98 } ]
  }
} }
```

### `chart`

```json
{ "type": "canvas.create", "artifact": {
  "id": "chart-1", "type": "chart", "title": "Revenue", "version": 1,
  "status": "complete",
  "data": {
    "chart": "bar", "xKey": "quarter",
    "rows": [ { "quarter": "Q1", "rev": 30 }, { "quarter": "Q2", "rev": 42 } ],
    "series": [ { "key": "rev", "label": "Revenue" } ]
  }
} }
```

From Python, prefer the emitters — they set `type` and shape for you:
`canvas.open_html`, `canvas.open_document`, `canvas.open_slides`,
`canvas.open_table`, `canvas.open_chart` (see `03-getting-started.md`).

## Rendering HTML you already have — the substrate approach

If your backend produces **pre-rendered HTML** for everything (a common reality
when slides/tables come from a code sandbox), keep `type: "html"` and tell the
canvas what the content *is* with `meta` and in-HTML markers. The HTML renderer
reads these; the inline card reads `meta.kind` for its icon/label.

| logical kind | `type` | how to signal it |
| ------------ | ------ | ---------------- |
| web page     | `html` | `meta: { kind: "web" }` (default) — fluid, scrolls |
| slide (PPT)  | `html` | `meta: { kind: "slide", ratio: "16:9" }` **and** a `.slide-container { width: 1280px; height: 720px }` (or `960×720` for `4:3`). `ratio` makes the renderer scale it as a fixed slide. |
| table (Excel)| `html` | put a `<div data-dataframe-table="true">…</div>` around the `<table>`; set `meta: { kind: "table" }` for the card label |

```json
{ "type": "canvas.create", "artifact": {
  "id": "slide-1", "type": "html", "title": "AI trends", "version": 1,
  "status": "complete",
  "data": { "html": "<!doctype html>…<div class=\"slide-container\" style=\"width:1280px;height:720px\">…</div>…" },
  "meta": { "kind": "slide", "ratio": "16:9" }
} }
```

Notes and gotchas:
- **`meta.ratio` (`"16:9"` / `"4:3"`) turns on fixed-slide scaling.** Without it a
  slide-sized page renders fluid (full-width), which reads as a plain web page.
- **A web page taller than the panel must be allowed to scroll.** If your template
  ships `body { overflow: hidden }` (fine for a fixed slide, fatal for a web page),
  the renderer overrides it for non-slide artifacts so the page scrolls — but only
  when `meta.ratio` is absent, so don't set `ratio` on a genuine web page.
- **There is no HTML-substrate path for a Word document yet.** A document only
  renders distinctly through the structured `type: "document"` shape above. Emitting
  a document as `type: "html"` falls through to the web renderer.

## Update semantics — which event to emit

| situation                                   | event            |
| ------------------------------------------- | ---------------- |
| open a new panel                            | `canvas.create`  |
| stream a document body token-by-token       | `canvas.append`  |
| progressively fill structured data (chart)  | `canvas.patch`   |
| a targeted edit that produces a new version | `canvas.replace` |
| flip streaming → done                       | `canvas.status`  |

`append` is a fast-path for the common "grow a markdown string" case; `patch` is
the general partial update (RFC-7386 JSON Merge Patch semantics: `null` deletes
a key, objects merge recursively, everything else replaces). `replace` is the
only event that creates a version — that is what the version rail pages through.

## Client → server: selection & targeted edits

The SSE wire is server→client only. The one client→server concern is **element
selection**: the `html` renderer runs an inspector in its sandboxed iframe that
stamps every element with a `data-cid` and reports the clicked element back to
the host via `postMessage`:

```ts
type ElementSelection = {
  artifactId: string;   // which html artifact
  cid: string;          // deterministic path id, e.g. "e-0-2"
  selector: string;     // "button.cta"
  tag: string;
  text?: string;
  outerHtml?: string;   // edit context for the agent
};
```

This rides the **chat request** (not the SSE stream): a targeted edit is a normal
turn with `selection` attached. The server frames it as an instruction to change
only that element and re-emit the page under the **same** `artifactId` (so the
reconciler updates in place). Node-scoped patching — updating a single `cid`
without resending the whole page — is a planned protocol extension
(`canvas.node_patch`); today an edit is a full `canvas.patch`/`replace` of the
`html` string.

## Versioning

Version history is **client-owned** and derived from the stream; it is never
re-sent in bulk. The reconciler keeps `history[id]: Artifact[]`, pushing a
snapshot on every `canvas.replace`. For durable, reload-surviving history,
persist snapshots in the LangGraph checkpointer keyed by `thread_id` and
`artifact.id` and hydrate the store on thread load — the wire protocol stays
identical.
