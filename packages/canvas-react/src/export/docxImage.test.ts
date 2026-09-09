import { afterEach, describe, expect, it, vi } from "vitest";
import fixtures from "./__fixtures__/docx-images.json";
import { readDocxImage } from "./docxImage";
import { documentToDocxDocument } from "./exporters";
import { markdownBlocks } from "./markdownBlocks";

import { assertEmbeddedImage } from "./__gate__/docxAssertions";

afterEach(() => vi.unstubAllGlobals());
describe("DOCX image bytes survive browser decoder variants", () => {
  for (const mode of ["absent", "rejecting", "available"] as const) {
    it.each(Object.entries(fixtures))(`${mode}: embeds valid %s bytes and relationship`, async (format, base64) => {
      const decoder = vi.fn(() => { throw new Error("decoder unavailable"); });
      vi.stubGlobal("createImageBitmap", mode === "absent" ? undefined : decoder);
      const { Packer } = await import("docx");
      const doc = await documentToDocxDocument({ format: "markdown", content: `![sample](data:image/${format};base64,${base64})` });
      await assertEmbeddedImage(new Uint8Array(await Packer.toBuffer(doc)), base64, format === "jpeg" ? "jpg" : format);
      expect(decoder).not.toHaveBeenCalled(); // header path allocates no bitmap to leak
    });
  }
  it.each(["AA==", "not base64!", fixtures.png.slice(0, 40), fixtures.jpeg.slice(0, -8), fixtures.gif.slice(0, -8)])("rejects invalid/truncated image %s", async (base64) => {
    expect(() => readDocxImage(base64)).toThrow("DOCX image");
  });
  it("rejects corrupt PNG chunk lengths and zero dimensions", () => {
    for (const offset of [8, 16]) {
      const bytes = Buffer.from(fixtures.png, "base64");
      bytes.writeUInt32BE(offset === 8 ? 0xffffffff : 0, offset);
      expect(() => readDocxImage(bytes.toString("base64"))).toThrow("DOCX image");
    }
  });
  it("raises on an unreadable supported data image at export", async () => {
    await expect(documentToDocxDocument({ format: "markdown", content: "![sample](data:image/png;base64,AA==)" })).rejects.toThrow("DOCX image");
  });
  it("raises for unsupported bytes and missing-alt malformed URIs", async () => {
    await expect(documentToDocxDocument({ format: "markdown", content: "![diagram](data:image/webp;base64,AA==)" })).rejects.toThrow("DOCX image");
    expect(() => markdownBlocks("![](data:image/png;base64,%%%)")).toThrow("DOCX image");
  });
  it("preserves alt text for malformed data URIs", () => {
    expect(markdownBlocks("![diagram](data:image/png;base64,%%%)" )).toEqual([["para", [{ text: "diagram", bold: false, italic: false, strike: false, code: false }]]]);
  });
});
