# Changelog

All notable changes to `@braincrew-lab/langchain-canvas` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/), and the
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **The panel chrome is the host's to word and to trim.** `<Canvas labels>`
  overrides any user-facing string the package renders (a partial map — the
  rest keep their defaults) and `<Canvas chrome>` leaves out pieces a host
  draws itself: the header, the status badge, undo/redo, the version rail,
  the Export menu, the Word-preview note and status line, a file card's
  facts or its download link. Counted: 54 always-visible strings and 116 editor-toolbar strings
  now route through `labels`; catalog names (themes, templates, fonts) and
  default content stay in the renderers on purpose. Both props default to
  the package's own look, so nothing moves for a host that passes nothing.
- **`buildExportActions`** lists the client-side exports for an artifact as
  data (label, extension, run), the same list `<ExportMenu />` draws — a host
  drawing its own export control gets identical files. The store publishes
  `renderedHtml`, the panel body's markup with editor chrome stripped, while
  an artifact is on screen.
- **`visibleTabs`, `workingCopyIds`, `WORKING_COPY_MARKER`, `SOURCES_PREFIX`**
  are public: a host can count and list files by the same rule the tab bar
  uses.
- CSS tokens `--cv-ok`, `--cv-ok-weak`, `--cv-danger`, `--cv-danger-weak`
  for the semantic colours the badge and delete affordances used to hardcode.

### Fixed
- **The person's first edit of an agent-written table no longer remounts the
  grid.** The workbook re-keyed when the artifact gained a `sheet` — which is
  exactly what the first hand edit creates — so a sheet someone had just
  added snapped back to Sheet1 with a flicker. The key now changes only for
  outside data changes and sort/filter views.
- **A `.md` file exports as `<stem>.docx`, not `<stem>.md.docx`.** The
  export stem now strips `.md`/`.markdown` like it strips the other canvas
  extensions.
- **A Korean title downloads under its own name.** `slugify` keeps letters
  and digits of any script; only punctuation and whitespace fold into
  dashes. `"매출 보고서"` used to download as `artifact.html`.

## [0.7.28] — 2026-09-01

### Fixed
- **No light engine no longer means blank cells.** With no formula evaluator
  configured, a save that writes formulas now falls through to the
  `xlsx_recalc` workbook engine (when wired) instead of leaving the cells
  without display values — a deployment that ships LibreOffice but not the
  formula CLI gets values on screen, at the cost of the engine's seconds on
  formula saves only.

## [0.7.27] — 2026-09-01

### Added
- **What the grid engine cannot run, the workbook engine can.** The table
  tools and the export tool take an `xlsx_recalc` hook (bytes → bytes; the
  reference deployment puts LibreOffice behind it). A save whose check left
  `#ERR` cells exports the sheet, recalculates the whole workbook, and lands
  the full-surface values on the cells — measured: `SUMPRODUCT`, outside
  every lighter engine, came back with LibreOffice's number, and a save with
  only supported formulas never spends the seconds. An `.xlsx` export leaves
  through the same hook, so the file opens showing numbers — including
  formulas a person typed straight into the grid.
- **A written formula lands with its value.** Measured: an agent's
  `=ROUND(H2*I2*2,0)` stored only the formula; the grid showed a blank cell,
  and cells depending on a changed value kept their stale cache. Now
  `write_table_cells` recomputes the whole sheet at save — dependents
  included — stamps every formula cell's display value, and grades the write
  in its reply (`J1 =ROUND(H1*I1*2,0) → 143000`). A formula the grid cannot
  run is flagged `#ERR` with a hint instead of showing a wrong number.
  `check_table` now verifies grid formulas too (it assumed "they evaluate in
  the grid"; an agent-written one did not), and the formula CLI gains a
  `sheets` mode (`computeSheetFormulas`) — same engine on both sides.
- **`set_slide_texts` — one slide, one save.** Replace the words of several
  text elements by id in a single call. Fourteen single-element edits with
  eight collisions (same-string matches, revision races) became one save per
  slide, one check, one image.
- **`review_deck` — look over the whole deck before handing it off.** The
  full check, a per-slide note of what changed against the original (and
  what still reads as the template's placeholder), and the deck's pages
  rendered next to the original's — grid to grid, or one slide large.
- **The export gate.** `export_canvas` refuses a deck whose check still
  names content-hiding findings (text past its box, boxes off the page,
  missing images) — those export as invisible words. `accept_findings=True`
  is the escape, for after the user has said to ship it as is.
- **Findings the copy inherited fold away.** The original's own overflowing
  boxes (recorded in the deck baseline, keyed by geometry) no longer repeat
  on every save; they fold into one closing line. A list that cannot reach
  zero is a list the model learns to ignore — measured riding along on all
  fourteen saves of one run.
- **The eye follows the change, at glance size.** A save's slide images now
  prefer the slides that save touched (not the lowest-numbered flagged
  ones), and arrive resized to 1024px JPEG — a third of the vision tokens,
  a tenth of the bytes of the full render it used to attach.
- **A text box can grow with its text, or shrink its type to fit.** `SlideElement`
  gains `autofit`: `shape` (the box takes the height its words need), `text`
  (the type shrinks to stay inside), `none` (the default — the deck check names
  the overflow). The pptx importer carries the original's setting across, the
  exporter writes `spAutoFit` / `normAutofit` with the grown height or the
  shrink, the editor, thumbnails, present view and print export draw the same
  box, and the deck check swaps the overflow finding for what an autofit box
  can still do wrong: grow off the page, or shrink below readable. One
  estimate on both sides (`slide_text.py` / `slideText.ts`, golden-tested).
  Counted before: four in ten text boxes in uploaded decks grow with their
  text, and every one arrived frozen at its placeholder's height.
- **The deck outline and the copy reply say which boxes do.** `grows` /
  `shrinks` after the size in `read_canvas`, and a count in the
  `open_deck_for_editing` reply, with the choice spelled out: let a growing box
  take its height, shorten the words, set `autofit`, or ask.

- **A canvas `.md` document leaves as a Word file.** `MarkdownDocxExporter`
  carries the same deliberate subset as the HTML door — headings, inline bold
  and italic, bullet and numbered lists, pipe tables, fenced code, page breaks,
  `data:` images. Before it, a canvas document could not be exported at all.
- **The Export menu takes host entries.** `Canvas` gains `exportExtras(artifact)`;
  entries are appended after the built-in ones (nothing is replaced) — the seam
  for server-side exports such as slides→pptx or table→xlsx.

- **A deck's tone is counted, and readable by key.** The outline now opens
  with `colors:` / `fonts:` / `sizes:` lines — every colour, face and size in
  the deck with usage counts, from every place a colour lives. And
  `read_canvas(fields="color,fontSize,...")` reads a deck as a projection:
  one compact line per element with just the asked keys, so a model checks
  the neighbours' style before adding an element instead of rereading the
  whole JSON. Unknown field names answer with the full vocabulary.
- **The fills a real deck uses all arrive.** Shape fills and outlines are
  read from the XML: theme references, preset colours, the style reference a
  shape inherits, and a gradient's first stop all resolve to hex — measured,
  only 23% of shape fills were explicit RGB, and a bank template painted 70%
  with theme references that used to arrive empty and render as black boxes.
  An explicit noFill becomes `fill: "none"`, the renderers stop guessing a
  colour for a silent shape (transparent, not the text colour), the exporter
  keeps "none" unfilled, and an unfilled, unbordered, textless spacer is not
  imported at all. A shape with no fill and no stroke is a new check finding.
- **The master rides behind the copy.** With a page renderer mounted,
  `open_deck_for_editing` renders the deck with every slide's own shapes
  removed and puts each page behind its slide as a display-only backdrop
  (`masterImage`, deduped per layout) — the logo and footer PowerPoint keeps
  out of reach on the slide stay visible while editing. The pptx exporter
  ignores it; the template skin carries the real master. Without a renderer
  the copy reply says the master is safe and returns on export.

## [0.7.26] — 2026-08-30

### Added
- **An uploaded workbook gets an editable working copy.** `workbook_working_copy`
  lands `<name>.table.json` next to a `sources/*.xlsx` upload, with the sheets,
  fonts, merges and formulas of the original. With the copy on the canvas the
  upload shows as a file card, so there is one grid — the one that saves.
- **The eye opens on its own.** `export_canvas` returns the exported file's page
  grid when a page renderer is mounted (`converters=`), and a deck save whose
  check names a slide returns that slide rendered. Measured before: told to look
  14 times, looked once.
- **Anchors take an address.** A Word edit may lead with the address the read
  printed — `"[p7] title"` — which picks that paragraph when the same words
  appear twice; the address alone means the whole paragraph.
- **A new deck takes the only PowerPoint upload as its template** when
  `template` is not set; `"template": null` opts out.
- **An upload being edited shows as its copy alone.** Once `deck.slides.json`,
  `book.table.json` or `Editing - memo.docx` is on the canvas, the
  `sources/` upload it came from has no tab of its own (the file list still
  has it). The copy names are one rule on both sides, parity-pinned.
- **A table's box grows to its rows.** Rows are as tall as their text needs,
  the way PowerPoint grows them; the element's box follows, so the selection
  frame, the deck check and the exported file agree. Cells take a 1.2 leading
  of their own instead of the host page's.
- **Undo is an edit.** Undo and redo work per file, reach `onUserEdit` (so
  what is on screen after undo is what gets saved), are refused while the
  canvas is busy, and a file's steps are forgotten once the agent writes it —
  the agent's result is a version on the rail, not a step to undo. A click
  that moves nothing is no longer recorded as an edit.
- **Pending saves can be flushed.** `useCanvasSave` returns a saver with
  `flush()`, and the store's `flushSaves()` blurs an edit in progress and
  hands every pending save through — for a host to call before a message
  starts a run, or before a version is named.
- **The canvas can be frozen while the agent works.** `<Canvas busy busyLabel=…>`
  shows a banner and the store refuses hand edits until the host thaws it.
- **A table's look is readable and copyable.** `read_canvas(sheet=…)` ends with
  `styles:` lines saying where each look lives; `write_table_cells` takes
  `{"v": …, "like": "A3"}` to copy a cell's style, plus explicit style keys.
- **The canvas tells the model where it stands.** `canvas_now` (for the system
  prompt) lists the files and what the person changed since the agent last
  wrote; `read_canvas` headers carry the file's last change (who, what, when);
  a deck read opens with a one-line-per-slide outline of every element.
- **The deck check sees text that wraps past its box**, and judges a deck copied
  from an upload by the upload's own smallest text size and page overhang.
- **A slide can hold a table.** A new `table` element type: the words as
  `rows` (a grid of strings), the grid line in `stroke`, column widths and
  row heights as percent of its box, and `cells` for what single cells do
  differently (a header fill, a bold total, a span). The editor draws a real
  `<table>` — a cell edits on double-click, a column's edge drags its width —
  and the pptx export writes a real PowerPoint table (merges, fills, grid
  lines), so the received file's table is still a table. The deck check
  reports rows that outgrow the box and small table text; the outline names
  a table by its grid and first row.
- **Tables and charts come across.** An uploaded deck's table arrives as one
  `table` element — its widths, merges, the look its cells share (from the
  cells' XML and the deck's table style sheet), and each cell's own fill or
  weight. A chart, with a page renderer mounted, is cut from the rendered
  page into `assets/` and placed as a picture; without one it is dropped and
  the reply says so.
- **Colourless text follows the slide, not the app.** An imported slide carries
  the theme's text colour as its default (`textColor`), and on the canvas and
  in the HTML export text with no colour of its own contrasts with the slide
  background instead of inheriting the app theme — a white slide's table cells
  are dark again.
- **A preset colour name is a colour.** `<a:prstClr val="white">` — the third
  way a file names a colour — now resolves through the standard table, so a
  white title on a dark slide no longer arrives colourless. WordArt takes its
  size from its box, as PowerPoint draws it.
- **A line is drawn by its stroke** on the canvas and in the HTML export, and
  keeps a visible thickness however thin its box.
- **Pictures leave the deck copy.** `open_deck_for_editing` stores pictures under
  `assets/<deck>/` and references them by path, so a copy is text the model can
  read whole (23 KB instead of 1.5 MB).

### Changed
- `write_canvas` refuses a `.slides.json` whose deck keys sit outside `data`, that
  does not match the schema, or that carries both `elements` and structured text;
  and a `.table.json` with keys outside `data`, that does not parse, or that would
  drop the person's grid state. The reply names the fix; nothing is saved.
- A table save is normalised so `columns` and `rows` are always present, and the
  table renderer no longer crashes when they are not.
- The small-text check judges a deck copied from an upload by the original's own
  smallest size, so its footnotes pass and only smaller new text is called out.
- `edit_canvas` with identical `old` and `new` saves nothing.
- An agent's write to a spreadsheet redraws the grid at once (`meta.remoteSeq`),
  where before it showed only after a reload.
- The spreadsheet grid does not persist Fortune's mount-time normalisation as an
  edit; a change counts once the person has pointed at or typed into the grid.
- Tool descriptions and `CANVAS_GUIDANCE` say, per office format, which file is
  edited and how; the refusal for writing into `sources/` names the way in.

## [0.7.25] — 2026-08-28

### Added
- **A PowerPoint deck can be imported and edited.** An uploaded `.pptx` is read
  into slide elements — shapes, text, position and colour — instead of staying a
  file you can only look at. `create_deck_tools` copies a deck out of `sources/`,
  where nothing is editable and no exporter matches the name, into a place where
  both work.
- **A slide element holds what a deck actually uses.** `stroke`, `strokeWidth`,
  `fontFamily`, `lineHeight`, `verticalAlign`, `highlight`, `spaceBefore` and
  `spaceAfter` are new fields on the slide protocol. Counted against one sample
  deck, the old model could not hold the font of 117 runs, the line spacing of 26
  paragraphs, the outline of 9 shapes or the vertical anchor of 9 frames. A shape
  with an outline and no fill had nothing to draw at all and came out invisible.

### Fixed
- **Print matches the screen.** The print page was built at 128 px per inch, so a
  10-inch deck printed as if it were 13.33 inches, and font size was written in
  `vw` — a share of the print frame — so the same deck printed at a different
  size depending on the frame. The page is now `widthIn * PAGE_DPI` with absolute
  px, the same numbers the screen uses. The print path also wrote none of the
  eight properties above; it writes all of them.
- **A slide is drawn the same way everywhere.** `textStyle(el, scale)` is shared
  by the editor, the thumbnail and the presenter view. Two bugs fell out of the
  merge: px properties were not multiplied by the view scale, so paragraph
  spacing opened at full size inside a thumbnail; and thumbnail text had a width
  but no height, so `overflow: hidden` had nothing to clip against and text ran
  over the slide below.
- **A slide wears the background it inherits.** PowerPoint resolves a background
  through slide, then layout, then master. Reading only the slide left 2 of 6
  sample slides white where the master says `#151515`. The chain is followed now,
  and all three colour notations are read (`srgbClr`, `schemeClr` with
  `lumMod`/`lumOff`, `prstClr`), along with gradients and picture fills.
- **A version number stops going backwards.** The version rail counted saved
  versions and the in-progress tail together, so it could read `v2 of 2` and then
  `v1 of 1`.
- **A tab is named after the file, not after what the file is.** A tab reads
  `Q3 review`, not `Q3 review.slides.json`.

## [0.7.24] — 2026-08-27

### Added
- **Third-party notices ship with the package.** The build bundles Fortune-sheet
  and its dependencies into `dist/`, so their code travels inside our tarball.
  Their MIT and Apache-2.0 terms ask us to carry their copyright notices with it,
  and the tarball held only our own `LICENSE`. `THIRD-PARTY-NOTICES` now lists the
  license text of all 12 bundled packages and is listed in `files`; `LICENSE`
  points to it. The notice also records the one change we make to
  `@fortune-sheet/core`.

## [0.7.23] — 2026-08-27

### Fixed
- **Spreadsheet grid renders again.** 0.7.22 dropped the `@fortune-sheet/react`
  CSS import from `TableRenderer` while bundling Fortune to remove `uuid`, so the
  sheet rendered as raw accessibility text without its grid styling. The import
  is restored; the tsup build resolves it at build time (Fortune is bundled) and
  also merges Fortune's stylesheet into the shipped `styles.css`. `uuid` stays
  fully removed from the dependency tree.

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
