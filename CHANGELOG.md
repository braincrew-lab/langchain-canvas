# Changelog

All notable changes to `@braincrew-lab/langchain-canvas` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/), and the
project adheres to [Semantic Versioning](https://semver.org/).

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
