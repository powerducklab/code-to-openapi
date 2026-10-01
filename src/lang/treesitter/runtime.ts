/**
 * Lazy web-tree-sitter runtime.
 *
 * The WASM runtime and grammar files stay external to the bundle so they load
 * from node_modules at runtime; the engine only initializes a grammar when a
 * project actually contains files for that language.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Anchor module resolution at this file so the external web-tree-sitter
// runtime and grammar WASMs load from node_modules in both ESM and CJS
// bundles. A bare `typeof require` probe is unreliable after bundling:
// bundlers inject a callable require shim even in ESM output, so require.resolve
// must be present before trusting it; otherwise anchor createRequire at the
// module URL (CJS output keeps a native require and never hits this branch).
/* eslint-disable @typescript-eslint/no-explicit-any */
const nodeRequire: NodeRequire =
  typeof require === "function" && typeof (require as any).resolve === "function"
    ? require
    : createRequire(import.meta.url);

export type GrammarName =
  | "python"
  | "go"
  | "java"
  | "c_sharp"
  | "rust"
  | "php";

/** Grammar id -> WASM file shipped by tree-sitter-wasms. */
const GRAMMAR_WASM: Record<GrammarName, string> = {
  python: "tree-sitter-python.wasm",
  go: "tree-sitter-go.wasm",
  java: "tree-sitter-java.wasm",
  c_sharp: "tree-sitter-c_sharp.wasm",
  rust: "tree-sitter-rust.wasm",
  php: "tree-sitter-php.wasm",
};

export interface TsNode {
  type: string;
  text: string;
  namedChildCount: number;
  childCount: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  namedChildren: TsNode[];
  children: TsNode[];
  parent: TsNode | null;
  childForFieldName(name: string): TsNode | null;
}

interface TreeParser {
  setLanguage(language: unknown): void;
  parse(source: string): { rootNode: TsNode };
}

interface WtModule {
  Parser: new () => TreeParser;
  Language: { load(file: string): Promise<unknown> };
}

let wtPromise: Promise<WtModule> | null = null;
const parserCache = new Map<GrammarName, Promise<TreeParser>>();

async function loadRuntime(): Promise<WtModule> {
  if (!wtPromise) {
    wtPromise = (async () => {
      // Load through the anchored require so the same package instance and
      // export shape is used regardless of ESM/CJS interop or hoisting.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wt: any = nodeRequire("web-tree-sitter");
      const Parser = wt.Parser ?? wt.default?.Parser;
      const Language = wt.Language ?? wt.Parser?.Language;
      if (!Parser || !Language) {
        throw new Error("web-tree-sitter runtime is unavailable.");
      }
      const entry = nodeRequire.resolve("web-tree-sitter");
      await Parser.init({
        locateFile: (file: string) => join(dirname(entry), file),
      });
      return { Parser, Language };
    })();
  }
  return wtPromise;
}

async function getParser(grammar: GrammarName): Promise<TreeParser> {
  let cached = parserCache.get(grammar);
  if (!cached) {
    cached = (async () => {
      const wt = await loadRuntime();
      const wasmPath = nodeRequire.resolve(
        `tree-sitter-wasms/out/${GRAMMAR_WASM[grammar]}`,
      );
      const language = await wt.Language.load(wasmPath);
      const parser = new wt.Parser();
      parser.setLanguage(language);
      return parser;
    })();
    parserCache.set(grammar, cached);
  }
  return cached;
}

/** Parses one source file; callers must never mutate the returned tree. */
export async function parseSource(
  grammar: GrammarName,
  source: string,
): Promise<TsNode> {
  const parser = await getParser(grammar);
  return parser.parse(source).rootNode;
}
