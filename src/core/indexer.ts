import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join, relative } from "node:path";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import ignoreFactory from "ignore";

import type { FileEntry, FileIndex } from "./types.js";

const ALWAYS_IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  "coverage",
  ".turbo",
  ".cache",
  "vendor",
  "target",
  "bin",
  "obj",
  "__pycache__",
  ".venv",
  "venv",
  "env",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".eggs",
  "site-packages",
  "egg-info",
]);

const TEST_FILE =
  /(?:\.test|\.spec|\.stories)\.[a-z]+$|_test\.go$|(?:^|[/\\])test_[^/\\]+\.py$|(?:^|[/\\])(?:tests?|__tests__|scripts?|examples?|fixtures?|e2e)[/\\]/i;

const EXTENSION_LANGUAGE: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
};

export interface IndexOptions {
  ignore?: readonly string[];
  includeTests?: boolean;
  maxFileBytes?: number;
}

interface IgnoreLike {
  add(pattern: string | readonly string[]): IgnoreLike;
  ignores(path: string): boolean;
}

function loadGitIgnore(root: string): IgnoreLike {
  const ig = (ignoreFactory as unknown as () => IgnoreLike)();
  for (const name of [".gitignore", ".powerduckignore"]) {
    try {
      const raw = readFileSync(join(root, name), "utf8");
      ig.add(raw);
    } catch {
      // No ignore file is the normal case.
    }
  }
  return ig;
}

/**
 * Recursively indexes source files. Honors .gitignore/.powerduckignore,
 * hard-excludes dependency and build output directories, and caps file size.
 */
export function indexProject(root: string, options: IndexOptions = {}): FileIndex {
  const maxFileBytes = options.maxFileBytes ?? 2 * 1024 * 1024;
  const ig = loadGitIgnore(root);
  if (options.ignore) ig.add(options.ignore);

  const files: FileEntry[] = [];

  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      const rel = relative(root, absolute).split("\\").join("/");

      if (entry.isDirectory()) {
        if (ALWAYS_IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        if (ig.ignores(`${rel}/`)) continue;
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;

      const dot = entry.name.lastIndexOf(".");
      const ext = dot >= 0 ? entry.name.slice(dot).toLowerCase() : "";
      const language = EXTENSION_LANGUAGE[ext];
      if (!language) continue;
      if (!options.includeTests && TEST_FILE.test(rel)) continue;
      if (ig.ignores(rel)) continue;

      let stat;
      try {
        stat = statSync(absolute);
      } catch {
        continue;
      }
      if (stat.size > maxFileBytes) continue;

      let content: string;
      try {
        content = readFileSync(absolute, "utf8");
      } catch {
        continue;
      }
      if (content.includes("\u0000")) continue; // binary guard

      files.push({
        path: rel,
        absolutePath: absolute,
        content,
        bytes: stat.size,
        hash: createHash("sha256").update(content).digest("hex"),
        language,
      });
    }
  };

  walk(root);

  files.sort((a, b) => a.path.localeCompare(b.path));
  const byPath = new Map(files.map((file) => [file.path, file]));
  return { files, byPath };
}
