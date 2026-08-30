import { afterEach, describe, expect, it, vi } from "vitest";

import type { Artifact } from "../protocol/artifacts";
import {
  ASSET_REFERENCE_PREFIXES,
  fetchAssetDataUri,
  inlineArtifactAssets,
  inlineHtmlAssets,
  isAssetReference,
  normalizeAssetReference,
  resolveAssetUrl,
  resolveCanvasFileUrl,
} from "./canvasAssets";

const BASE = "http://host/api/canvas/t1/file?path=";
const PNG = new Uint8Array([137, 80, 78, 71]);
const PNG_B64 = btoa(String.fromCharCode(...PNG));
const PNG_URI = `data:image/png;base64,${PNG_B64}`;

/** Serve PNG bytes for the given asset paths; 404 everything else. */
function stubFetch(served: string[]): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (url: string) => {
    const path = decodeURIComponent(String(url).slice(BASE.length));
    if (!served.includes(path)) return { ok: false } as Response;
    return {
      ok: true,
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: async () => PNG.buffer,
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => vi.unstubAllGlobals());

describe("isAssetReference / resolveAssetUrl", () => {
  it("recognizes exactly the contract prefixes", () => {
    expect(ASSET_REFERENCE_PREFIXES).toEqual(["assets/", "sources/"]);
    expect(isAssetReference("assets/logo.png")).toBe(true);
    expect(isAssetReference("sources/photo.jpg")).toBe(true);
    expect(isAssetReference("exports/out.docx")).toBe(false);
    expect(isAssetReference("https://x/assets/logo.png")).toBe(false);
    expect(isAssetReference(undefined)).toBe(false);
  });

  it("appends the URI-encoded path to the base", () => {
    expect(resolveAssetUrl("assets/my logo.png", BASE)).toBe(
      `${BASE}assets%2Fmy%20logo.png`,
    );
  });

  it("folds document-relative forms onto the root", () => {
    // A model writing report/02-site.html tends to produce ../sources/… —
    // store paths can never contain .., so the root reading is lossless.
    expect(normalizeAssetReference("../sources/photo.png")).toBe("sources/photo.png");
    expect(normalizeAssetReference("./assets/logo.png")).toBe("assets/logo.png");
    expect(normalizeAssetReference("../report/01.html")).toBeNull();
    expect(isAssetReference("../sources/photo.png")).toBe(true);
    expect(resolveAssetUrl("../sources/photo.png", BASE)).toBe(`${BASE}sources%2Fphoto.png`);
  });
});

describe("resolveCanvasFileUrl", () => {
  it("resolves a stored file wherever it sits, without widening the reference gate", () => {
    // I2 — a `file` artifact's own path needs no guessing, and asking the
    // reference gate about it would leave a canvas-root file with no URL.
    const root = "Editing - plan.docx";
    expect(isAssetReference(root)).toBe(false);
    expect(resolveCanvasFileUrl(root, BASE)).toBe(`${BASE}Editing%20-%20plan.docx`);
    expect(resolveCanvasFileUrl("sources/plan.docx", BASE)).toBe(
      `${BASE}sources%2Fplan.docx`,
    );
    expect(resolveCanvasFileUrl("exports/out.docx", BASE)).toBe(
      `${BASE}exports%2Fout.docx`,
    );
  });
});

describe("fetchAssetDataUri", () => {
  it("encodes fetched bytes with the served content type", async () => {
    stubFetch(["assets/logo.png"]);
    expect(await fetchAssetDataUri("assets/logo.png", BASE)).toBe(PNG_URI);
  });

  it("returns null on a failed fetch", async () => {
    stubFetch([]);
    expect(await fetchAssetDataUri("assets/missing.png", BASE)).toBeNull();
  });
});

describe("inlineHtmlAssets", () => {
  it("inlines relative references in both quote styles", async () => {
    stubFetch(["assets/logo.png", "sources/photo.png"]);
    const out = await inlineHtmlAssets(
      `<img src="assets/logo.png"> <img src='sources/photo.png'>`,
      BASE,
    );
    expect(out).toBe(`<img src="${PNG_URI}"> <img src='${PNG_URI}'>`);
  });

  it("inlines the document-relative form a model writes from a folder", async () => {
    stubFetch(["sources/photo.png"]);
    const out = await inlineHtmlAssets(`<img src="../sources/photo.png">`, BASE);
    expect(out).toBe(`<img src="${PNG_URI}">`);
  });

  it("inlines the display form a rendered DOM serializes", async () => {
    stubFetch(["assets/logo.png"]);
    const out = await inlineHtmlAssets(`<img src="${BASE}assets%2Flogo.png">`, BASE);
    expect(out).toBe(`<img src="${PNG_URI}">`);
  });

  it("leaves unresolvable references untouched and skips fetch when none match", async () => {
    const mock = stubFetch([]);
    const html = `<img src="assets/missing.png"> <img src="https://x/y.png">`;
    expect(await inlineHtmlAssets(html, BASE)).toBe(html);
    const none = `<p>no images</p>`;
    expect(await inlineHtmlAssets(none, BASE)).toBe(none);
    expect(mock).toHaveBeenCalledTimes(1); // only the missing.png attempt
  });
});

describe("inlineArtifactAssets", () => {
  const artifact = (type: string, data: unknown): Artifact => ({
    id: "a1",
    type,
    title: "T",
    version: 1,
    status: "complete",
    data,
  });

  it("passes through without an asset base", async () => {
    const a = artifact("html", { html: `<img src="assets/logo.png">` });
    expect(await inlineArtifactAssets(a, null)).toBe(a);
  });

  it("inlines html page sources", async () => {
    stubFetch(["assets/logo.png"]);
    const a = artifact("html", { html: `<img src="assets/logo.png">` });
    const out = await inlineArtifactAssets(a, BASE);
    expect((out.data as { html: string }).html).toBe(`<img src="${PNG_URI}">`);
    expect(a.data).toEqual({ html: `<img src="assets/logo.png">` }); // input untouched
  });

  it("inlines a canonical deck's html source (same as an html artifact)", async () => {
    stubFetch(["assets/logo.png"]);
    const a = artifact("slides", {
      html: `<!doctype html><html><body><template data-slide-id="s1"><img src="assets/logo.png"></template></body></html>`,
    });
    const out = await inlineArtifactAssets(a, BASE);
    expect((out.data as { html: string }).html).toContain(PNG_URI);
    expect(a.data).toEqual({
      html: `<!doctype html><html><body><template data-slide-id="s1"><img src="assets/logo.png"></template></body></html>`,
    }); // input untouched
  });

  it("leaves a legacy { slides: [...] } deck untouched — nothing to inline into", async () => {
    stubFetch(["assets/logo.png"]);
    const a = artifact("slides", {
      slides: [{ layout: "image", image: "assets/logo.png" }],
    });
    expect(await inlineArtifactAssets(a, BASE)).toBe(a);
  });

  it("leaves other artifact types untouched", async () => {
    stubFetch(["assets/logo.png"]);
    const a = artifact("table", { columns: [], rows: [] });
    expect(await inlineArtifactAssets(a, BASE)).toBe(a);
  });
});
