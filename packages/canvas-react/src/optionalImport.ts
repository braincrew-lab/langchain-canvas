/**
 * Load an optional peer dependency, failing with an actionable message.
 *
 * The Office/formula engines (`exceljs`, `docx`, `pptxgenjs`,
 * `fast-formula-parser`) are `optionalDependencies` and kept out of the bundle,
 * so a consumer who never exports to those formats doesn't pay for them. When a
 * feature that needs one is used without it installed, surface a clear install
 * hint instead of a raw `ERR_MODULE_NOT_FOUND`.
 *
 * Pass a thunk with the literal `import("pkg")` so bundlers still code-split it.
 */
export async function loadOptional<T>(pkg: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (err) {
    const error = new Error(
      `langchain-canvas: this feature requires the optional package "${pkg}", which isn't installed. Add it with:  npm i ${pkg}`,
    );
    (error as Error & { cause?: unknown }).cause = err;
    throw error;
  }
}
