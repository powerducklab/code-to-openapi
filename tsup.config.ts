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
    external: ["typescript", "web-tree-sitter", "tree-sitter-wasms"],
  },
]);
