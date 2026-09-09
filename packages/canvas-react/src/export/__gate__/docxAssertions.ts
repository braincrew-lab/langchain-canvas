import { createRequire } from "node:module";
import { expect } from "vitest";
// Reuse docx's installed ZIP dependency; no new runtime dependency.
const require = createRequire(import.meta.url);
const JSZip = createRequire(require.resolve("docx"))("jszip");
export async function assertEmbeddedImage(bytes: Uint8Array, base64: string, type: string) {
  const zip = await JSZip.loadAsync(bytes);
  const media = Object.keys(zip.files).filter((name) => name.startsWith("word/media/") && !zip.files[name].dir);
  expect(media).toHaveLength(1);
  expect(media[0]).toMatch(new RegExp(`\\.${type}$`));
  expect(await zip.file(media[0]).async("base64")).toBe(base64);
  const rels: string = await zip.file("word/_rels/document.xml.rels").async("string");
  const name = media[0].replace("word/", "");
  expect(rels).toContain(`Target="${name}"`);
  expect(rels).toContain("/relationships/image");
  const xml: string = await zip.file("word/document.xml").async("string");
  expect(xml).toContain('cx="114300" cy="66675"'); // 12 x 7 px at 9525 EMU/px
  const relationship = Array.from(rels.matchAll(/<Relationship\b[^>]+>/g)).find((m) => m[0].includes(`Target="${name}"`))?.[0];
  const id = relationship?.match(/\bId="([^"]+)"/)?.[1];
  expect(id).toBeTruthy();
  expect(xml).toContain(`r:embed="${id}"`);
}
