/** Header-only image metadata for DOCX: no browser decoder or pixel allocation.
 * Original compressed bytes are embedded unchanged. This validates container
 * bounds/dimensions, not compressed pixel integrity (the Office reader decodes).
 */
export function readDocxImage(base64: string): {
  type: "png" | "jpg" | "gif";
  bytes: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
} {
  const invalid = () => new Error("DOCX image: unsupported or invalid PNG/JPEG/GIF data");
  let binary: string;
  try { binary = atob(base64); } catch { throw invalid(); }
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const ascii = (start: number, length: number) => binary.slice(start, start + length);
  const result = (type: "png" | "jpg" | "gif", width: number, height: number) => {
    if (!width || !height || width > 0x7fffffff || height > 0x7fffffff) throw invalid();
    return { type, bytes, width, height };
  };
  if (ascii(0, 8) === "\x89PNG\r\n\x1a\n") {
    if (bytes.length < 33 || view.getUint32(8) !== 13 || ascii(12, 4) !== "IHDR") throw invalid();
    let hasData = false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = view.getUint32(offset);
      if (length > bytes.length - offset - 12) throw invalid();
      const kind = ascii(offset + 4, 4);
      if (kind === "IDAT" && length > 0) hasData = true;
      offset += length + 12;
      if (kind === "IEND") {
        if (length !== 0 || !hasData || offset !== bytes.length) throw invalid();
        return result("png", view.getUint32(16), view.getUint32(20));
      }
    }
    throw invalid();
  }
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") {
    if (bytes.length < 14 || bytes[bytes.length - 1] !== 0x3b) throw invalid();
    let offset = 13 + ((bytes[10] & 0x80) ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0);
    let hasImage = false;
    while (offset < bytes.length - 1) {
      const kind = bytes[offset++];
      if (kind === 0x2c) {
        if (offset + 9 > bytes.length || !view.getUint16(offset + 4, true) || !view.getUint16(offset + 6, true)) throw invalid();
        const packed = bytes[offset + 8];
        offset += 9 + ((packed & 0x80) ? 3 * (1 << ((packed & 7) + 1)) : 0);
        if (offset >= bytes.length - 1 || bytes[offset] < 2 || bytes[offset] > 8) throw invalid();
        offset++; // LZW minimum code size
        hasImage = true;
      } else if (kind === 0x21) offset++; // extension label, then sub-blocks
      else throw invalid();
      let length: number;
      do {
        if (offset >= bytes.length - 1) throw invalid();
        length = bytes[offset++];
        offset += length;
      } while (length);
    }
    if (!hasImage || offset !== bytes.length - 1) throw invalid();
    return result("gif", view.getUint16(6, true), view.getUint16(8, true));
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let width = 0, height = 0;
    for (let offset = 2; offset < bytes.length;) {
      if (bytes[offset++] !== 0xff) throw invalid();
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (offset + 2 > bytes.length) throw invalid();
      const length = view.getUint16(offset);
      if (length < 2 || length > bytes.length - offset) throw invalid();
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8 || length !== 8 + 3 * bytes[offset + 7]) throw invalid();
        height = view.getUint16(offset + 3);
        width = view.getUint16(offset + 5);
      }
      if (marker === 0xda) {
        if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) throw invalid();
        return result("jpg", width, height);
      }
      offset += length;
    }
  }
  throw invalid();
}
