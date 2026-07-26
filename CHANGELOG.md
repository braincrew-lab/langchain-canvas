# Changelog

All notable changes to `@braincrew-lab/langchain-canvas` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/), and the
project adheres to [Semantic Versioning](https://semver.org/).

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
