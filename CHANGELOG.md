# Changelog

All notable changes to `@braincrew-lab/langchain-canvas` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/), and the
project adheres to [Semantic Versioning](https://semver.org/).

## [0.3.0] — 2026-07-31

The file-compatibility and spreadsheet release: PowerPoint / Word / 한글 files
now open on the canvas with their formatting, the spreadsheet grows an
Excel-style ribbon with a live formula engine, the whole chrome speaks Korean,
and artifacts gain durable, described version history.

### Added — open real files (all importers dependency-free)
- **`.pptx` import** — a PowerPoint deck opens as a native editable slide deck:
  EMU→percent geometry, theme-color resolution (clrScheme + clrMap with
  lumMod/tint approximations), layout/master placeholder inheritance,
  slide-background chain, per-paragraph splitting, tables as cell grids,
  annotation connectors as thin rules (flipH/flipV diagonals), `a:alpha`
  carried as #RRGGBBAA, and a Korean-aware overflow guard. Verified on real
  36-slide corporate decks (colored text 37→340, placeholder fallbacks 24→0).
- **`.docx` import** — headings, lists, tables, bold/italic run merging → a
  document artifact.
- **`.hwp` / `.hwpx` open with their formatting** — Korean documents render as
  a white A4 page (맑은 고딕 stack) with per-run size/color/bold/underline,
  paragraph alignment, real bordered tables with colspan/rowspan and cell
  backgrounds, and embedded images; binary `.hwp` gets the same page chrome
  for its text + reconstructed tables. Imports land as `meta.kind: "doc"`
  artifacts with a dedicated **document mode** (📄 chip, no web-builder
  chrome, jump-to-heading outline).
- **`.hwpx` export** — a document artifact saves as an OWPML package (zero-dep
  ZIP writer with real CRC-32) that Hancom 한글 2014+ opens: "한글 (HWPX)" in
  the Export menu.
- **`type: "pdf"` artifact + `.pdf` import** — the browser's native viewer in
  the canvas with a clean toolbar (zoom − / Fit / +, download, open) and the
  native chrome hidden.

### Added — spreadsheet (Excel)
- **Excel-style ribbon** — captioned groups (삽입 · 글꼴 · 맞춤 · 표시 형식 ·
  편집 · 보기) as soft keycap trays: bold (가/B by locale), Excel-style color
  swatches (glyph over a live color bar), SVG alignment glyphs, merge/unmerge,
  number-format menu (₩/$/%/thousands/decimal/date), Σ AutoSum, sort, filter,
  틀 고정, clean-styling.
- **Formula bar + live engine** — an A1 cell reference + `=formula` editing
  row; formulas compute through the sheet's engine (VLOOKUP, IF, IFERROR,
  COUNTIF, SUMIF, INDEX+MATCH, CONCATENATE, LEFT, ROUND/AVERAGE all verified
  live; ~338-function catalog). Σ AutoSum writes the formula below the
  selection like Excel.
- **Fortune internals re-themed** — dialogs, right-click menus, sheet tabs,
  tooltips, and scrollbars now follow the canvas design tokens; the duplicate
  built-in formula row is hidden.

### Added — slides, charts, i18n, versioning
- **Slide elements rotate** (15° stepper + exact degrees, carried to PPTX and
  print exports), **thumbnail drag-reorder**, and **image fit (cover/contain)
  + corner radius**.
- **Scatter and donut** chart types.
- **`<Canvas locale="ko">`** — the entire chrome (toolbars, menus, states,
  tooltips) localized; typed dictionary with English fallback.
- **Durable version history** — `canvas.commit` events stamp described
  snapshots; the version rail opens a popover listing them; an `onSave` hook
  (debounced) plus a `CanvasStore` protocol with in-memory and filesystem
  backends persists snapshots (Python: standard canvas tools with enforced
  read-before-update).

### Fixed
- **Streamed tables no longer render empty.** Fortune's mount-echo onChange
  could persist an empty pre-stream snapshot over the real rows; echoes are
  now consumed, and persisted sheets are normalized (celldata rebuilt from the
  runtime matrix) so remounts and CSV/XLSX exports read real cells.
- **Type scales with the slide.** Free-slide text renders in container-query
  units (px@1280 → cqw), so the editor, thumbnails, and present mode agree at
  any width; PPTX export uses PowerPoint's true 16:9 page so px→pt
  round-trips exactly; print-HTML dropped a long-standing ≈1.78× font
  inflation. Round-trip on a real deck: 36→36 slides, 787→787 elements,
  fontSize 28→28.
- **Fill-less shapes are frames, not slabs** — imported outline-only
  rectangles used to paint solid with the text color (black slabs over
  content); editor, thumbnails, and both exports now draw transparent outline
  frames.
- Text paints past its box like PowerPoint (overflow visible) with matched
  1.2 line-height; Excel number formats localize; the formula bar flattens
  Fortune's syntax-highlight HTML to plain "=…" text; the PDF panel fills its
  height and hides the browser viewer's UUID chrome.

### Docs
- README overhaul (EN/KO, root + npm): hero, badges, real screenshots,
  verified feature groups; per-type contract table includes `pdf`.

## [0.2.0] — 2026-07-29

A milestone release: Figma-grade slide editing, a real spreadsheet formatting
toolbar, a native PDF viewer, Korean HWP/HWPX import, a rewritten Excel
number-format engine, and eighteen verified bug fixes across the SDK.

### Added — slides (PPT), Figma-grade editing
- **Multi-select** — Shift+click toggles elements; dragging empty canvas draws a
  marquee that selects everything it touches. A floating action bar on the
  selection offers group/ungroup, align (left/center/right/top/middle/bottom),
  duplicate, and delete.
- **Group / ungroup** — ⌘G / ⌘⇧G (new optional `SlideElement.group` field);
  grouped elements select and move as one, and survive reloads.
- **Keyboard editing** — arrow-key nudge (0.5%, Shift = 2%), ⌘D duplicate,
  ⌘C/⌘V copy/paste (works across slides), ⌘] / ⌘[ z-order, Delete, Esc.
- **Aspect-lock resize** — hold Shift while resizing to keep the ratio.
- **Smart guides on resize** — the existing drag snapping now also applies while
  resizing (slide center, edges, and other elements' edges, 1.2% threshold).
- **8 editorial themes** (Editorial, Gallery, Boardroom, Sage, Graphite,
  Observatory, Ultramarine, Bordeaux) with per-theme accent + font stack (new
  optional `Slide.accent` / `Slide.fontFamily`), and **7 accent-aware layouts**
  (title, section divider, agenda, bullets, two-column, big stat, quote).
- **Present-mode progress** — a slim progress bar and a "3 / 12" counter.

### Added — tables (Excel)
- **Clean styling** — one click strips every cell fill and font colour (agents
  sometimes generate garishly coloured sheets; this restores a readable grid).
- **Selection formatting** — bold, fill colour, text colour, and align
  left/center/right for the selected range, in the sheet toolbar.
- **Freeze header** — a toggle that pins the top row while scrolling.

### Added — new formats
- **PDF viewer** — new `type: "pdf"` artifact (`{ src, filename? }`) rendered in
  the browser's built-in viewer (data:/blob:/https sources; data: URLs are
  re-served through a blob: URL pinned to `application/pdf`). `.pdf` files can
  also be dropped straight onto the canvas.
- **HWPX import** — `.hwpx` (Hancom OWPML) opens as a document artifact:
  paragraphs and tables → markdown, via a dependency-free ZIP reader
  (`DecompressionStream`) and `DOMParser`.
- **HWP import** — binary `.hwp` (HWP 5.x) text extraction: a from-scratch CFB
  container parser + record-stream walker, zero dependencies; encrypted/DRM/
  legacy files fail with clear bilingual guidance.

### Fixed — Excel number formats (rewritten engine)
- Quoted literals, `\`-escapes, and locale/colour groups no longer leak into
  cell text — `yyyy"-"mm"-"dd` now renders `2026-07-01`, not `2026"-"07"-"01`.
- **Time formats**: `m`/`mm` adjacent to hours/seconds now means minutes (was
  always rendering the *month*), `AM/PM` works with a real 12-hour clock, and
  elapsed formats (`[h]:mm`) render true durations.
- Percent formats keep their thousands separators (`12,345.6%`), negative
  sections render their parentheses (`(1,234.50)`), trailing currency stays
  trailing (`1,234.50 €`), and rich-text cells import their text (previously
  dropped, or `[object Object]` in the flat view).
- Date/time cells use the file's own (UTC-anchored) calendar parts, so times no
  longer shift by the viewer's timezone.

### Fixed — security
- **"Open in new tab" no longer runs artifact scripts in the host origin** — the
  raw HTML blob was same-origin with the app; it now opens through a wrapper
  page whose sandboxed iframe mirrors the canvas's own sandbox.
- The PDF viewer pins data: sources to `application/pdf`, so a crafted
  `data:text/html` artifact can't smuggle a scriptable same-origin frame.

### Fixed — editing correctness
- **CSV export includes user edits** — it read only the original stream shape
  and silently discarded every in-grid edit (xlsx export already did this right).
- **Old versions are read-only previews** — editing while viewing v1 silently
  overwrote the live version (and node patches resolved v1 paths against v2
  HTML); the version rail also no longer crashes when an agent re-`create`s an
  artifact while an old version is open.
- **Undo/redo now fire `onUserEdit`** — the host/backend stayed holding content
  the user had just undone.
- The editor's injected scroll-fix `<style>` no longer persists into the saved
  artifact (it accumulated one copy per structural edit and leaked into exports).
- Free-dragging a single element now persists its parent's `position:relative`
  too — dropped elements no longer jump on the next reload.
- Second and later element groups get fresh ids (they used to collide with "g0"
  after a reload and merge with the first group).
- On a fixed-aspect slide, inserting with nothing selected lands inside
  `.slide-container` (was appended below the visible slide — invisible).
- 4:3 slides render on a true 960×720 canvas (the stage assumed 1280 wide).
- Chart cells accept typed negative numbers (the controlled input snapped "-"
  back to 0); Code view keeps your in-progress source when agent deltas stream
  in (it remounted and wiped the draft); outline indentation actually shows;
  replaying a new scenario mid-replay no longer flips the playing state off.

### Fixed — web (HTML) authoring
- **Inserted blocks match the page's design.** A new Button (or heading/text)
  now adopts the computed style of its existing peers — colours, radius,
  padding, font — instead of landing as a bare UA-styled tag; on a page with no
  buttons it falls back to a clean accent default.
- **Free-drag positions are stable.** The vertical position commits in px (a
  container's content-driven height reflows once the element leaves the flow,
  so a %-of-height top landed somewhere else after every reload), and a static
  `<body>` is pulled to `position:relative` so its absolute children stop
  resolving against the page root. Dropped elements stay exactly where they
  were dropped — verified Δ0.0px across a Code→Design reload.

## [0.1.15] — 2026-07-28

### Added
- **Auto layout for slides (Figma-style).** An "⤢ Arrange…" menu on the deck
  toolbar tidies every element on the slide: stack them into an evenly-spaced
  vertical or horizontal column (sorted by position, centered on the cross axis),
  snap them to a shared edge (align left / center / right / top / middle / bottom),
  or distribute the gaps evenly (vertical / horizontal).

## [0.1.14] — 2026-07-26

### Changed
- **Polished, consistent toolbar buttons.** Every renderer's controls now share one
  button language — a consistent 8px radius, a hairline of depth, a soft hover
  lift, a tactile press, and a visible focus ring; segmented controls (Design/Code,
  device preview) and primary actions (Present) get a subtle accent gloss. Works in
  both light and dark themes.

## [0.1.13] — 2026-07-26

### Added
- **Slide padding (deck).** A "Pad" field on the SlidesRenderer toolbar sets a
  per-slide content padding (percent of the slide) that insets the free canvas —
  applied consistently in the editor, thumbnails, present mode, PDF, and PPTX.
- **Chart PNG export.** A "⤓ PNG" button downloads the chart as a 2× PNG
  (`echarts.getDataURL`), available for both editable and raw-option charts.
- **Table sort & filter.** The spreadsheet toolbar gains a "Sort…" column picker
  (with an asc/desc toggle) and a debounced "Filter…" box that narrows rows by a
  substring match across columns.

### Fixed
- **Shape controls are one bar.** A selected slide shape put its fill-color swatch
  in a separate floating popover from its duplicate/reorder/delete controls; the
  fill swatch now lives in the same control bar, so shape editing reads as one
  cohesive toolbar.

## [0.1.12] — 2026-07-26

### Added — document & chart editing
- **Document formatting toolbar.** Editing a document now shows a toolbar to bold,
  italicize, inline-code, add H1/H2, bullet/numbered lists, quotes, and links —
  wrapping the selection in Markdown — plus a live **word count and read-time**.
- **Chart title.** Charts take an optional title, shown above the plot and set from
  a "Chart title…" field in the toolbar (new `ChartOptions.title`).

## [0.1.11] — 2026-07-26

### Added — web (HTML) authoring usability
- **Full-page starters.** A "Page…" menu drops a complete page (Landing / SaaS /
  Portfolio) composed from the section templates — undoable, so it's safe to try.
- **Page outline.** An "Outline…" menu lists the page's headings and jumps the
  preview to any of them (new `scroll_to` iframe command).
- **Accessibility check.** A "♿ Check" button scans the page for missing alt text,
  unlabeled links/buttons/form fields, a missing `<html lang>`, and a missing
  `<h1>`, and lists what it finds.

## [0.1.10] — 2026-07-26

### Added — web (HTML) authoring usability
- **Bigger component library.** The section-insert menu grows from 3 to 11
  ready-made sections: Hero, Features, Call to action, Nav bar, Pricing, Stats,
  Testimonial, FAQ, Gallery, Contact form, Footer.
- **Lists in the rich-text bar.** The in-place text toolbar adds bullet and
  numbered lists alongside bold / italic / underline / link.
- **Copy HTML** and **Open in new tab** in the Export menu — grab the markup or
  preview the page full-size without downloading a file.

## [0.1.9] — 2026-07-26

### Added — slide (PPT) authoring
- **Slide-native toolbar.** On a fixed-aspect slide the Add palette now offers only
  slide-appropriate blocks (Heading / Text / Image), and the web section-template
  dropdown (hero/features/CTA) is hidden — the toolbar reads as a slide editor, not
  a web-page builder.
- **Slide layouts.** A "Layout…" dropdown inserts 10 slide-native layouts: title,
  section, bullets, two-column, image+text, quote, agenda, big-stat, comparison,
  closing.
- **Slide themes.** A "Theme…" dropdown recolors the slide in one click (Light /
  Paper / Ink / Navy / Forest / Sunset / Brand), via a new `set_slide_style`
  iframe command that styles the `.slide-container` root.
- **Shapes.** A "Shape…" dropdown drops in a rectangle, circle, line, arrow, or pill.
- **Slide fonts.** A "Font…" dropdown sets the slide-wide typeface (Sans / Serif /
  Mono / Rounded / Condensed) on the slide root.
- **Background image.** A "🖼 BG" button embeds an uploaded image as the slide's
  cover-fit background (data URI, self-contained).
- **Text controls on selection.** Align left / center / right and Bold a selected
  text element (a new persisting `style_persist` iframe command).

### Added — SlidesRenderer (native `type: "slides"` deck)
- **Shapes.** A "+ Shape" control drops a rectangle, ellipse, or line onto the
  slide; shapes drag/resize/duplicate/reorder like any element, take a fill color,
  and render in the editor, thumbnails, present mode, PDF, and PPTX (via
  `addShape`). New `SlideElement` fields `shape` and `fill`.
- **Quick layouts.** A "Layout…" dropdown replaces the current slide's elements
  with a structured layout (title / section / bullets / two-column / quote).
- **More themes.** Theme presets expanded to 8 (added Paper, Navy, Forest).
- **Background image.** A "🖼 BG" button sets a cover-fit image as the slide
  background (PPTX skips non-solid backgrounds rather than corrupting the fill).
- **Present mode polish.** Slides fade in as you advance (respecting
  `prefers-reduced-motion`), and speaker notes show below the slide for the
  presenter.

### Fixed — slide export fidelity
- **Accurate HTML/PDF export for slides.** An html-substrate slide previously
  printed onto a default A4-portrait page and got clipped. `htmlSlideToPrintHtml`
  now wraps a fixed-aspect slide with an `@page` rule sized to the slide
  (16:9 → 1280×720, 4:3 → 960×720, zero margin) and pins the `.slide-container`
  to it, so the PDF is one clean full-bleed slide. The HTML download carries the
  same sizing, so it displays and prints correctly.

## [0.1.8] — 2026-07-26

### Added
- **`onUserEdit` write-back hook.** `<Canvas onUserEdit={fn} />` fires `fn(artifact)`
  after the user edits an artifact directly in the canvas — a table cell, a chart
  value, document text, a slide/HTML element — with the reconciled artifact. Every
  direct edit funnels through the store's `applyUserEvent`, so one hook covers all
  renderers; agent-driven updates never fire it. Lets a host sync in-canvas edits
  back to the agent/backend so the next turn sees them. Also exposed on the store
  as `setOnUserEdit` and the `UserEditHandler` type.

### Fixed
- **Table edits now land on the undo stack** and fire `onUserEdit` — `TableRenderer`
  routed cell edits through `applyEvent` (no undo, no write-back) instead of
  `applyUserEvent`.

## [0.1.7] — 2026-07-23

### Fixed
- **Web artifacts now scroll next to the chat.** Slide-derived agent templates
  often ship `body{overflow:hidden}`, which is correct for a fixed 1280×720 slide
  but traps a tall fluid web page inside the iframe with no scrollbar. Non-slide
  (no `meta.ratio`) artifacts now get a last-wins
  `html,body{overflow:auto!important;height:auto!important}` injected into their
  `srcDoc`, so the page scrolls; slides keep their fixed overflow.
  (`HtmlRenderer`)

## [0.1.6] — 2026-07-23

### Fixed
- **Code → Design no longer renders blank.** Toggling to Code unmounts the Design
  stage; `useSlideFit`'s `ResizeObserver` then fired at `clientWidth` 0 and
  computed a negative scale, shrinking the returning iframe to nothing. The fit
  now skips the update when the box is unmeasurable (`w <= 40`), keeping the last
  good scale. (`HtmlRenderer`)

## [0.1.5] — 2026-07-23

Republished via `pnpm publish` so the `publishConfig` dist-exports swap applies
(see 0.1.4). Same fixes as the withdrawn 0.1.4.

### Fixed
- **Artifact cards label by kind, not just renderer type.** `ArtifactCard` now
  derives its icon/label from a producer-supplied `meta.kind`
  (`web` / `table` / `slide` / `document`), falling back to `type`. A host that
  renders slides/tables through the HTML substrate (so `type` stays `"html"`) no
  longer shows every artifact as "Web page".
- **Code → Design keeps its content.** `HtmlRenderer` rebuilds `srcDoc` on return
  to Design view. The self-edit short-circuit was only valid while the same iframe
  stayed mounted; in Code view the iframe unmounts, so the remount was loading a
  stale (or empty) cached `srcDoc` and rendering blank.
- **Panel scrolls vertically.** Added `min-height: 0` to `.cv-body` /
  `.cv-html-wrap` and dropped the forced `min-height: 70vh` on `.cv-html`, so the
  height-bounded stage lets the web iframe scroll.

## [0.1.4] — 2026-07-23 [WITHDRAWN]

> **Do not use.** Published with `npm publish`, which does not apply the
> `publishConfig` `main`/`exports` swap, so the package shipped pointing at
> `./src` (absent from the tarball) and failed to resolve for consumers
> (`Module not found: Can't resolve '@braincrew-lab/langchain-canvas'`).
> Deprecated on npm; superseded by **0.1.5**, which carries the same fixes.

## [0.1.0] — 2026-07-17

Initial published release.

[0.3.0]: https://github.com/braincrew-lab/langchain-canvas/releases/tag/v0.3.0
[0.2.0]: https://github.com/braincrew-lab/langchain-canvas/releases/tag/v0.2.0
[0.1.15]: https://github.com/braincrew-lab/langchain-canvas/releases/tag/v0.1.15
[0.1.14]: https://github.com/braincrew-lab/langchain-canvas/releases/tag/v0.1.14
[0.1.13]: https://github.com/braincrew-lab/langchain-canvas/releases/tag/v0.1.13
[0.1.12]: https://github.com/braincrew-lab/langchain-canvas/releases/tag/v0.1.12
[0.1.11]: https://github.com/braincrew-lab/langchain-canvas/releases/tag/v0.1.11
[0.1.10]: https://github.com/braincrew-lab/langchain-canvas/releases/tag/v0.1.10
[0.1.9]: https://github.com/braincrew-lab/langchain-canvas/releases/tag/v0.1.9
[0.1.8]: https://github.com/braincrew-lab/langchain-canvas/releases/tag/v0.1.8
[0.1.7]: https://github.com/braincrew-lab/langchain-canvas/releases/tag/v0.1.7
[0.1.6]: https://github.com/braincrew-lab/langchain-canvas/releases/tag/v0.1.6
[0.1.5]: https://github.com/braincrew-lab/langchain-canvas/releases/tag/v0.1.5
[0.1.4]: https://github.com/braincrew-lab/langchain-canvas/releases/tag/v0.1.4
[0.1.0]: https://github.com/braincrew-lab/langchain-canvas/releases/tag/v0.1.0
