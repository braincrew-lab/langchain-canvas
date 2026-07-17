/** Browser download helpers — trigger a file save from an in-memory string. */

/** Save `content` as a file named `filename` with the given MIME type. */
export function downloadBlob(filename: string, mime: string, content: BlobPart): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** Turn a title into a safe file stem: "Q1 Report!" -> "q1-report". */
export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "artifact"
  );
}
