import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
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
  external: ["react", "react-dom", "exceljs", "docx", "pptxgenjs", "fast-formula-parser"],
  async onSuccess() {
    const fs = await import("node:fs");
    // The bundle ships React components/hooks, so the entry is a Client Component
    // boundary — prepend "use client" so it imports directly into a Next.js App
    // Router / RSC host. (esbuild drops in-source directives when bundling, so we
    // inject it into the final output here.)
    const entry = "dist/index.js";
    const code = fs.readFileSync(entry, "utf8");
    if (!code.startsWith('"use client"')) fs.writeFileSync(entry, `"use client";\n${code}`);
    // Ship the stylesheet alongside the JS (imported as "@langchain-canvas/react/styles.css").
    fs.copyFileSync("src/styles/canvas.css", "dist/styles.css");
  },
});
