# @braincrew-lab/langchain-canvas

A canvas for your LangChain chat app. Your agent streams an artifact — a web page, a spreadsheet, a slide deck, a chart, a document — and it shows up next to the conversation, live and editable. Users can tweak it by hand and export it to a real file.

Think ChatGPT Canvas or Claude Artifacts, but a package you drop into your own React app and point at your own agent.

> [한국어 README](./README.ko.md)

```tsx
const { sendMessage, messages, canvas } = useCanvasStream({ endpoint: "/api/chat" });
// user: "make a pricing table for 3 plans"
// → a real spreadsheet appears in <Canvas />, formulas and all
```

## Install

```bash
npm i @braincrew-lab/langchain-canvas
```

`docx`, `docx-preview` and `fast-formula-parser` come along with the package. If
one is missing, that single feature says what to add and the rest keeps working:
an export tells the user, and a Word upload falls back to the file card it showed
before.

**A spreadsheet is opened and written from the Python side**, through
`xlsx_import` and `TableXlsxExporter` in `langchain-canvas[xlsx]`. Reading a
workbook down to its fonts, fills, number formats, merges, widths and images is
more than a browser should carry, and the two readers are held to the same
result by a golden fixture. The grid itself is unchanged: a table artifact still
opens, edits and exports to CSV in the browser.

**A deck exports to PowerPoint from the Python side**, through
`SlidesPptxExporter` in `langchain-canvas[office]`. It builds on the deck's
template skin, so the original's masters, layouts and embedded fonts survive —
which the browser never had. The export menu offers PDF for a deck; wire the
Python exporter behind an endpoint of your own for `.pptx`.

## Mount it

Two things: the hook that receives your agent's stream, and the panel that renders it. They share a store, so nothing is wired between them.

```tsx
import { Canvas, useCanvasStream } from "@braincrew-lab/langchain-canvas";
import "@braincrew-lab/langchain-canvas/styles.css";

function App() {
  const { sendMessage, messages } = useCanvasStream({ endpoint: "/api/chat" });
  return <Canvas />; // render sendMessage/messages in your own chat UI
}
```

- `useCanvasStream({ endpoint })` → `{ sendMessage, messages, canvas, isStreaming, editSelection }`.
- `<Canvas />` ships with `"use client"`, so it drops into a **Next.js App Router** file as-is.
- `/api/chat` streams SSE using the wire protocol (`canvas.create` / `append` / `patch` / `replace`). The companion Python package emits these from a LangChain/LangGraph agent; any backend sending the same JSON frames works.

That's the whole setup. The rest of this README is **how to use each feature** — all of it is direct manipulation the user does on the rendered artifact, with no extra code from you.

---

## Features & how to use them

### 🌐 Web pages (`html`) — a visual page builder

HTML is the base substrate, rendered in a sandboxed iframe. Selecting and editing works on any HTML the agent produces.

- **Click to select** — hover highlights an element, click selects it.
- **Drag to move** — drag a selected element to reposition it (uses a CSS transform, so it's non-destructive and keeps the page's flow/responsiveness).
- **Alignment snap guides** — while moving, edges/centers snap to nearby elements and the container center, with red guide lines (like Figma).
- **Resize handle** — drag the corner to resize. **Images resize in `%`**, so they scale with the layout — smaller on mobile, larger on desktop.
- **Marquee select** — drag a box to select everything fully inside it; the selection is predictable (outermost items, drilling into a wrapper of several children).
- **Group / ungroup** — select 2+ elements and Group; they get a shared id (no wrapper, so layout never breaks) and move together. Click a member to select the group, then Ungroup.
- **Edit text inline** — double-click any text; a floating toolbar gives **bold / italic / underline / link**.
- **Style inspector** — color, background, font size/weight, line-height, letter-spacing, padding, radius, width, plus **background gradients and background images** (upload or URL).
- **Replace images** — select an image → **Upload** a file (embedded as a data URI) or paste a **URL**.
- **Add blocks** — insert a heading, text, button, image, or divider from the toolbar.
- **Section templates** — drop in a ready-made **Hero / Features / Call-to-action** section (self-styled and responsive).
- **Structural actions** — duplicate, delete, reorder (move up/down) the selected element.
- **Responsive preview** — toggle **Desktop / Tablet / Mobile** width; media queries respond as they would on a real device.
- **Code view** — switch to **Code** to edit the raw HTML by hand; switch back to **Design** and the change is live. A viewport meta is injected automatically so the page is responsive on export.
- **Selection → agent** — pass `onEditElement` and a "apply an instruction to this selection" bar appears, so the user can ask the agent to change exactly what they picked.

### 📊 Spreadsheets (`table`) — a real spreadsheet

Runs on a spreadsheet engine (Fortune-sheet), not a static table.

- **Live formulas** — type `=SUM(C2:C4)`, `=AVERAGE(...)`, `=A2*B2`; they calculate, with cell references, ranges, and function autocomplete.
- **Formulas from data** — a formula the agent sends as a value (e.g. `"=AVERAGE(B2:B4)"`) is **pre-computed on load** so it shows its result immediately.
- **Full toolbar** — fonts, number/currency/percent formats, bold/italic, borders, cell merging, alignment, multiple sheets — like a desktop spreadsheet.
- **Smooth scrolling** in both directions over a large grid.
- **Export** to `.csv` here, or to `.xlsx` with fonts, merges and formats through the Python side.

### 🖼️ Slides (`slides`) — a free-canvas deck

A PowerPoint-style editor where every element is movable.

- **Free positioning** — drag and resize text/image elements; snap to guides.
- **Inline editing** — double-click to edit text; format toolbar for bold/size/color/align.
- **Structure** — add/duplicate/delete/reorder slides, thumbnails rail, speaker notes.
- **Themes & backgrounds**, present mode (full-screen, arrow-key navigation).
- **Export** to `.pptx`, or copy to **Figma** (paste straight in as editable frames), or **PDF** (all slides).

### 📝 Documents (`document`) — Markdown / Word

- **Click-to-edit** the page as Markdown, rendered with GFM.
- **Export** to `.docx`, `.md`, `.pdf`, or `.html`.

### 📈 Charts (`chart`)

- **Line / bar / area / pie**, switchable in one click.
- **Edit data inline** — a small grid to change values, add/remove rows.
- **Recolor** each series (or each pie slice), rename series, set the y-axis label, toggle stacking.
- **Export** to `.pdf` (the chart is SVG, so it prints crisply) or the raw JSON.

### 📁 Files — round-trip

- **Import** by drag-and-drop or a file picker: **CSV · Markdown · HTML · JSON**. They open as editable artifacts. A spreadsheet is opened on the Python side (`xlsx_import`).
- **Export** every artifact to its native format, plus a universal **standalone `.html`** and **PDF** (browser print).

### 🧰 Across every artifact

- **Undo / redo** — `⌘Z` / `⌘⇧Z` (or the toolbar buttons) revert *user* edits (agent streaming isn't polluted into the stack).
- **Version history** — each `canvas.replace` snapshots a version you can step back through.
- **Error isolation** — a renderer that throws shows an inline fallback instead of crashing the host app.
- **Multiple canvases** — wrap trees in `<CanvasProvider>` to run independent instances in one app.

---

## Wrapping it in your app

- **Peer dependency:** React 18 or 19 — you bring your own. ESM only.
- **Styles:** `import "@braincrew-lab/langchain-canvas/styles.css"` once.
- **Isolated instances:** `<CanvasProvider>` gives each subtree its own store.
- **Bring your own renderer:** pass `registry` to add or override how a type renders.

```tsx
import { Canvas, mergeRegistries, builtinRenderers } from "@braincrew-lab/langchain-canvas";

const registry = mergeRegistries(builtinRenderers, {
  metric: ({ artifact }) => <div className="big-number">{artifact.data.value}</div>,
});

<Canvas registry={registry} />
```

### No backend? Replay a fixture or mock the chat

```tsx
import { useCanvasReplay, scenarios } from "@braincrew-lab/langchain-canvas";

const { play } = useCanvasReplay();
useEffect(() => { play(scenarios.find((s) => s.id === "table")!.events); }, [play]);
```

```tsx
useCanvasStream({ mock: (msg) => (/chart/i.test(msg) ? chartEvents : null) }); // null → hit the endpoint
```

## Theming

Light is the default theme, and every color, radius, shadow and font in the stylesheet
is a CSS variable — retheme by overriding `--cv-*` tokens, no forking required.

```tsx
import "@braincrew-lab/langchain-canvas/styles.css";
```

### Tokens

A representative slice of the contract (see
`packages/canvas-react/src/styles/canvas.css` for the full 27-token list and current
values):

| Token | Purpose | Light default |
|---|---|---|
| `--cv-bg` / `--cv-surface` | Canvas background / card surface | `#F9FAFB` / `#FFFFFF` |
| `--cv-border` / `--cv-border-soft` | Primary / subtle borders | `#D1D6DB` / `#E5E8EB` |
| `--cv-text` / `--cv-text-secondary` / `--cv-muted` | Text hierarchy | `#191F28` / `#333D4B` / `#6B7684` |
| `--cv-tag-bg` | Tag/pill background | `#F2F4F6` |
| `--cv-accent` / `--cv-accent-weak` / `--cv-accent-text` / `--cv-accent-border` | Accent family (active tabs, badges, focus rings) | `#9360FF` / `#F5F0FF` / `#5232B3` / `#E0D4F5` |
| `--cv-cta` / `--cv-cta-hover` | Primary call-to-action | `#704BD6` / `#5B3CC4` |
| `--cv-sidebar-active` / `--cv-sidebar-selected` | Sidebar row states | `#EFE4F7` / `#F7F2FB` |
| `--cv-user-bubble` | Chat user bubble background | `#191F28` |
| `--cv-destructive-text` / `--cv-destructive-light` / `--cv-destructive-border` | Destructive actions | `#B91C1C` / `#FEF2F2` / `#FECACA` |
| `--cv-radius` / `--cv-radius-md` / `--cv-radius-xl` | Corner radii | `2px` / `6px` / `20px` |
| `--cv-shadow-card` | Card elevation | `0 2px 8px rgba(25,31,40,0.06)` |
| `--cv-font` / `--cv-font-display` / `--cv-mono` | Typography (see Fonts below) | — |

### Overriding tokens

Set the variables on `:root` (or any ancestor of `<Canvas />`), after the stylesheet import:

```css
:root {
  --cv-accent: #2563eb;
  --cv-radius: 8px;
}
```

### Dark mode

Dark is no longer automatic. The dark palette lives under an explicit `.dark` class
scope — add it to `<html>` (or any ancestor of `<Canvas />`) to activate it:

```html
<html class="dark">
```

**Restoring automatic OS dark mode:** the stylesheet previously matched
`prefers-color-scheme: dark` on its own; that media query was removed so the host
controls the active theme. If your app relied on it, re-add it in your own
stylesheet, mirroring the `.dark` overrides:

```css
@media (prefers-color-scheme: dark) {
  :root:not(.dark) {
    --cv-bg: #0f1115;
    --cv-surface: #171a21;
    --cv-border: #262b36;
    --cv-text: #e6e8eb;
    --cv-muted: #9aa4b2;
    --cv-accent: #818cf8;
    --cv-accent-weak: #1e2130;
  }
}
```

### Fonts

`--cv-font`, `--cv-font-display` and `--cv-mono` ship as generic font-stack names
(`"Pretendard", "Sora", -apple-system, ...` / `"Sora", "Pretendard", ...` /
`"IBM Plex Mono", Menlo, monospace`) — no font files are bundled with this package.
Load the named families in your own app, or override the variables with fonts you
already load, if you want them to actually render.

## How it works

```
agent  ──SSE──▶  canvas events  ──▶  reconciler  ──▶  store  ──▶  renderer
                (create/append/patch/replace)   (pure function)          │
                                                                         ▼
                        user edits (type / drag / select)  ──▶  same reconciler
```

The reconciler is a single pure function — every change (a streamed token, a user edit, a new version) goes through it, so state stays predictable and auditable. Renderers only read the reconciled artifact.

## Security

Agent output and imported files are treated as untrusted:

- HTML renders in an iframe with `sandbox="allow-scripts"` and **no** `allow-same-origin` — a null origin with no reach into your app's DOM, cookies, or storage (the Claude Artifacts model).
- PDF export renders in a **script-disabled** sandboxed iframe, so exporting a malicious page can't run anything in your origin.
- Imported Markdown renders without raw-HTML passthrough.

### Dependency advisories

`pnpm audit` and `npm audit` report nothing against this package. Two of its
dependencies still resolve old transitive packages that carry advisories, and
neither publishes a release that lifts them, so pin them in **your** app — a
lockfile override only applies to the project that declares it, never to a
library you install.

npm / yarn:

```json
"overrides": {
  "uuid": "14.0.1",
  "brace-expansion": "^2.1.4",
  "@ungap/structured-clone": "1.3.0"
}
```

pnpm:

```json
"pnpm": { "overrides": {
  "uuid@<14.0.1": "14.0.1",
  "brace-expansion@<1.1.17": "^1.1.17",
  "brace-expansion@>=2.0.0 <2.1.4": "^2.1.4",
  "@ungap/structured-clone": "1.3.0"
} }
```

`uuid` is ESM-only from v12 on, and `@fortune-sheet/core` still reaches it
through a CommonJS entry. Node resolves that with `require(esm)`,
which landed in **20.19**, so pinning `uuid` past v11 raises this package's floor
to that release — hence the `engines` field. Bundlers take the ESM entry and are
unaffected; it is plain `node` that needs the newer runtime. On Node 20.18 the
grid fails to load at all, so the floor is not advisory.

With those in place `npm audit` and `pnpm audit` both report nothing on a fresh
install of this package. The same overrides run in this repository's own
lockfile, against its full test suite.

Advisory feeds disagree, and a private one may flag a version the public feed
calls clean — pin to whatever your own review has cleared. The versions above are
the ones this repository tests against.

`@ungap/structured-clone` cannot be removed — `react-markdown` reaches it through
`mdast-util-to-hast`, whose current release still depends on it. It is **ISC** and
carries no advisory, so any 1.x is fine; the entry above pins the exact version in
case your review clears versions one at a time. Markdown, GFM tables and links all
render against the pinned one.

## License

MIT
