import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

import type { FileIndex, LanguagePack, ScanContext } from "../../core/types.js";
import { createSchemaContext, type SchemaContext } from "./typeSchema.js";

export interface TsAnalysis {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ts: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  checker: any;
  /** Relative project path -> SourceFile. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sourceByPath: Map<string, any>;
  schemaContext: SchemaContext;
  isProjectFile: (fileName: string) => boolean;
}

function loadTypeScript(root: string): any {
  const localRequire = createRequire(join(root, "package.json"));
  try {
    return localRequire("typescript");
  } catch {
    try {
      return createRequire(import.meta.url)("typescript");
    } catch (cause) {
      throw new Error(
        "typescript is required to scan TypeScript/JavaScript projects (install the optional peer dependency).",
        { cause },
      );
    }
  }
}

function compilerOptions(ts: any, root: string, index: FileIndex): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  host: any;
} {
  const configPath = join(root, "tsconfig.json");
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf8");
    const parsed = ts.parseConfigFileTextToJson(configPath, raw);
    if (parsed.config) {
      const base = ts.parseJsonConfigFileContent(
        parsed.config,
        ts.sys,
        root,
        undefined,
        configPath,
      );
      return {
        options: {
          ...base.options,
          noEmit: true,
          skipLibCheck: true,
        },
        host: undefined,
      };
    }
  }

  return {
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      allowJs: true,
      checkJs: false,
      esModuleInterop: true,
      resolveJsonModule: true,
      skipLibCheck: true,
      strict: false,
      noEmit: true,
    },
    host: undefined,
  };
}

export function createTsAnalysis(ctx: ScanContext): TsAnalysis {
  const ts = loadTypeScript(ctx.root);
  const { options } = compilerOptions(ts, ctx.root, ctx.index);

  const rootNames = ctx.index.files
    .filter((file) =>
      ["typescript", "javascript"].includes(file.language),
    )
    .map((file) => file.absolutePath);

  const program = ts.createProgram({
    rootNames,
    options,
    projectReferences: [],
  });
  const checker = program.getTypeChecker();

  const projectRootNames = new Set(rootNames);
  const isProjectFile = (fileName: string) =>
    projectRootNames.has(fileName) ||
    (!fileName.includes("node_modules") &&
      !/lib\.d\.ts$/.test(fileName) &&
      fileName.startsWith(ctx.root));

  const sourceByPath = new Map<string, any>();
  for (const name of rootNames) {
    const source = program.getSourceFile(name);
    if (source) {
      const rel = name.slice(ctx.root.length + 1).split("\\").join("/");
      sourceByPath.set(rel, source);
    }
  }

  const schemaContext = createSchemaContext(ts, checker, isProjectFile);

  return {
    ts,
    program,
    checker,
    sourceByPath,
    schemaContext,
    isProjectFile,
  };
}

export const typescriptPack: LanguagePack<TsAnalysis> = {
  id: "typescript",
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  analyze(ctx) {
    const hasTs = ctx.index.files.some((f) =>
      [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].some((ext) =>
        f.path.endsWith(ext),
      ),
    );
    if (!hasTs) return null;
    return createTsAnalysis(ctx);
  },
};
