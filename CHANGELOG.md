# Changelog

All notable changes to `@braincrew-lab/langchain-canvas` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/), and the
project adheres to [Semantic Versioning](https://semver.org/).

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

[0.1.7]: https://github.com/braincrew-lab/langchain-canvas/releases/tag/v0.1.7
[0.1.6]: https://github.com/braincrew-lab/langchain-canvas/releases/tag/v0.1.6
[0.1.5]: https://github.com/braincrew-lab/langchain-canvas/releases/tag/v0.1.5
[0.1.4]: https://github.com/braincrew-lab/langchain-canvas/releases/tag/v0.1.4
[0.1.0]: https://github.com/braincrew-lab/langchain-canvas/releases/tag/v0.1.0
