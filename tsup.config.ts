import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: false,
    target: "node18",
    platform: "node",
    minify: "terser",
    // Inject CJS-compatible import.meta.url / require shims; the tree-sitter
    // runtime and TypeScript loader call createRequire(import.meta.url).
    shims: true,
    // typescript is resolved from the consuming project; tree-sitter runtime
    // and its WASM payload must stay external to preserve asset resolution.
    external: ["typescript", "web-tree-sitter", "tree-sitter-wasms"],
  },
]);
