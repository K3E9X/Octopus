// Loader hooks for `node --test`.
//
// 1. The codebase uses extensionless relative imports (Next/bundler style). Node's
//    ESM loader needs explicit extensions, so append ".ts".
// 2. Bundlers import JSON without an import attribute; Node requires `with {type:
//    "json"}`. Rather than write bundler-hostile syntax in production code, the test
//    loader supplies the attribute.
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && !/\.(ts|js|mjs|cjs|json)$/i.test(specifier)) {
    try { return await nextResolve(specifier + ".ts", context); } catch { /* fall through */ }
  }
  if (/\.json$/i.test(specifier)) {
    return nextResolve(specifier, { ...context, importAttributes: { type: "json" } });
  }
  return nextResolve(specifier, context);
}

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Short-circuit JSON so Node's attribute validation never sees it. */
export async function load(url, context, nextLoad) {
  if (/\.json$/i.test(url)) {
    return { format: "json", source: await readFile(fileURLToPath(url), "utf8"), shortCircuit: true };
  }
  return nextLoad(url, context);
}
