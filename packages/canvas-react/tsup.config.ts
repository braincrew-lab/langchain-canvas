import { defineConfig } from "tsup";
import { createRequire } from "node:module";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "langgraph/index": "src/langgraph/index.ts",
    // Node CLI for the check_table tool — same formula modules as the client.
    "formula-cli": "src/io/formulaCli.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: false, // keep the published tarball small; heavy deps are external anyway
  clean: true,
  treeshake: true,
  // Split the lazy renderers (recharts / react-markdown / fortune-sheet) into
  // their own chunks so a consumer only downloads what their artifacts use.
  splitting: true,
  // Keep the optional Office/formula engines OUT of the bundle — they're declared
  // in optionalDependencies and pulled via guarded dynamic import, so the core
  // stays ~100 KB and a Node builtin (exceljs → crypto) never leaks into a chunk.
  external: [
    "react",
    "react-dom",
    "exceljs",
    "docx",
    "docx-preview",
    "fast-formula-parser",
  ],
  // Bundle Fortune-sheet into our (lazy) chunks so consumers never install
  // @fortune-sheet/* — that dependency was the last source of `uuid` in the
  // tree (its core generated sheet ids with uuid.v4()). We ship a patched,
  // uuid-free copy (patches/@fortune-sheet__core), so a plain install has zero
  // uuid. Fortune stays a devDependency: needed to build, never to consume.
  noExternal: ["@fortune-sheet/react", "@fortune-sheet/core"],
  async onSuccess() {
    const fs = await import("node:fs");
    // The bundle ships React components/hooks, so the entry is a Client Component
    // boundary — prepend "use client" so it imports directly into a Next.js App
    // Router / RSC host. (esbuild drops in-source directives when bundling, so we
    // inject it into the final output here.)
    const entry = "dist/index.js";
    const code = fs.readFileSync(entry, "utf8");
    if (!code.startsWith('"use client"')) fs.writeFileSync(entry, `"use client";\n${code}`);
    // Ship the stylesheet alongside the JS (imported as "@braincrew-lab/langchain-canvas/styles.css").
    // Fortune-sheet is bundled (not a runtime dep), so its stylesheet has to
    // travel with ours — append it so consumers get the grid styling from the
    // single styles.css they already import.
    const req = createRequire(import.meta.url);
    const fortuneCss = fs.readFileSync(req.resolve("@fortune-sheet/react/dist/index.css"), "utf8");
    fs.writeFileSync(
      "dist/styles.css",
      fs.readFileSync("src/styles/canvas.css", "utf8") + "\n\n/* --- @fortune-sheet/react (bundled) --- */\n" + fortuneCss,
    );
  },
});
