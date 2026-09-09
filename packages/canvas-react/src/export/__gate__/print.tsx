/**
 * Test-only entry for the print gate (`snugBullet.browser.test.ts`).
 *
 * Drives the PRODUCTION print path up to its `print()` call: the deck's real
 * `slidesToPrintHtml` sheet goes through the exported `preparePrintFrame`
 * (`../pdf.ts`) — the same sandboxed `srcdoc` frame, the same wait and the
 * same `fitSnugLines` call `printToPdf` makes. Nothing about readiness is
 * added here. `?font=` / `?family=` put an `@font-face` for the render
 * image's face into the SHEET (the frame's own document — a real sheet's
 * faces live there too), never into this host page, so a measurement taken
 * with a host canvas or before the frame's face has arrived cannot match.
 * Once the frame is ready the body is marked and the frame is opened up from
 * production's 0 x 0 to 960 x 540 so the gate can screenshot it (the fit is
 * already written inline; the sheet's px geometry does not change).
 * Served by the Vite dev server the test starts; never part of the package.
 */

import type { SlidesData } from "../../protocol/artifacts";
import parityDeck from "../__fixtures__/parity-deck.slides.json";
import snugDeck from "../__fixtures__/snug-bullet.slides.json";
import { slidesToPrintHtml } from "../exporters";
import { preparePrintFrame } from "../pdf";

const params = new URLSearchParams(location.search);
const deck = (params.get("deck") === "parity" ? parityDeck : snugDeck) as { title: string; data: SlidesData };
const fontUrl = params.get("font") ?? "";
const family = params.get("family") ?? "";
const fontCss =
  fontUrl && family && !/["\\<>]/.test(fontUrl + family)
    ? `<style>@font-face { font-family: "${family}"; src: url("${fontUrl}"); font-weight: 400; font-style: normal; }</style>`
    : "";

const sheet = slidesToPrintHtml(deck.data, deck.title).replace("<head>", `<head>${fontCss}`);
void preparePrintFrame(sheet).then((iframe) => {
  Object.assign(iframe.style, { position: "static", display: "block", width: "960px", height: "540px" });
  document.body.dataset.snugFit = "done";
});
