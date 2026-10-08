import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { dirname, join, relative } from "node:path";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import ignoreFactory from "ignore";

import type { FileEntry, FileIndex } from "./types.js";

// Directory names that are always dependency or cache directories, never
// source packages.
const ALWAYS_IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  "coverage",
  ".turbo",
  ".cache",
  "vendor",
  "__pycache__",
  ".venv",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".eggs",
  "site-packages",
  "egg-info",
  ".gradle",
]);

// Build-output directory names that can legitimately appear as source package
// names (e.g. a Java package named "target"); only ignore them when build
// markers prove they are generated output.
const CONDITIONAL_BUILD_DIRS = new Set(["dist", "build", "out", "target", "bin", "obj"]);

function hasEntry(dir: string, predicate: (name: string) => boolean): boolean {
  try {
    return readdirSync(dir).some(predicate);
  } catch {
    return false;
  }
}

/**
 * Python virtualenvs are conventionally named "env" or "venv", but those are
 * also common source package names (e.g. a Java `...api.env` package). Only
 * skip the directory when it carries unmistakable virtualenv markers.
 */
function isPythonVirtualenv(absolute: string): boolean {
  return (
    hasEntry(absolute, (entry) => entry === "pyvenv.cfg") ||
    hasEntry(absolute, (entry) => entry === "activate") ||
    (hasEntry(absolute, (entry) => entry === "bin") &&
      hasEntry(absolute, (entry) => entry === "lib"))
  );
}

/**
 * Distinguish build output from source packages that share the same directory
 * name. Maven compiles into ./target next to a pom.xml; Gradle next to
 * build.gradle(.kts); .NET emits bin/obj next to a project file or with
 * Debug/Release artifacts; JS/Python build dirs keep their conventional names.
 */
function isConditionalBuildOutput(absolute: string, name: string): boolean {
  const parent = dirname(absolute);
  if (name === "target") {
    if (
      existsSync(join(parent, "pom.xml")) ||
      existsSync(join(parent, "build.gradle")) ||
      existsSync(join(parent, "build.gradle.kts")) ||
      existsSync(join(parent, "settings.gradle")) ||
      existsSync(join(parent, "settings.gradle.kts"))
    ) {
      return true;
    }
    return hasEntry(absolute, (entry) =>
      ["classes", "test-classes", "maven-status", "generated-sources", "generated-test-sources"].includes(entry),
    );
  }
  if (name === "bin" || name === "obj") {
    if (hasEntry(parent, (entry) => /\.(csproj|sln|fsproj|vbproj)$/.test(entry))) {
      return true;
    }
    return hasEntry(
      absolute,
      (entry) =>
        entry === "Debug" ||
        entry === "Release" ||
        /\.(dll|exe|pdb|cache)$/i.test(entry),
    );
  }
  // dist/build/out: only treat as generated output next to a project manifest
  // and with unmistakable build artifacts; a source package sharing the name
  // must stay indexed.
  const parentHasManifest =
    existsSync(join(parent, "package.json")) ||
    existsSync(join(parent, "pyproject.toml")) ||
    existsSync(join(parent, "setup.py")) ||
    existsSync(join(parent, "pom.xml")) ||
    existsSync(join(parent, "build.gradle"));
  if (!parentHasManifest) return false;
  return hasEntry(absolute, (entry) =>
    ["assets", "static", "lib", "bdist.linux-x86_64"].includes(entry),
  ) || hasEntry(absolute, (entry) => /\.(map|whl|tar\.gz|egg)$/i.test(entry));
}

const TEST_FILE =
  /(?:\.test|\.spec|\.stories)\.[a-z]+$|_test\.go$|(?:^|[/\\])test_[^/\\]+\.py$|Test\.java$|Tests\.cs$|Test\.php$|(?:^|[/\\])(?:tests?|__tests__|scripts?|fixtures?|e2e)[/\\]|^examples?[/\\]/i;

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
  ".java": "java",
  ".cs": "csharp",
  ".rs": "rust",
  ".php": "php",
};

export interface IndexOptions {
  ignore?: readonly string[];
  includeTests?: boolean;
  maxFileBytes?: number;
  maxFiles?: number;
  maxTotalBytes?: number;
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
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) throw new Error("maxFileBytes must be a positive safe integer");
  const maxFiles = options.maxFiles ?? 10_000;
  const maxTotalBytes = options.maxTotalBytes ?? 64 * 1024 * 1024;
  for (const [name, value] of Object.entries({maxFiles,maxTotalBytes})) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  }
  let totalBytes = 0;
  const unresolved: NonNullable<FileIndex["unresolved"]> = [];
  const omitted = (path: string, message: string) => unresolved.push({reason:"source-skipped", message, origin:{file:path || "."}});
  const ig = loadGitIgnore(root);
  if (options.ignore) ig.add(options.ignore);

  const files: FileEntry[] = [];

  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
    } catch {
      omitted(relative(root, dir).split("\\").join("/"), "Source directory could not be read; scan coverage is incomplete");
      return;
    }

    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      const rel = relative(root, absolute).split("\\").join("/");

      if (entry.isDirectory()) {
        if (entry.name.startsWith(".")) continue;
        if (ALWAYS_IGNORE_DIRS.has(entry.name)) continue;
        if (
          (entry.name === "env" || entry.name === "venv") &&
          isPythonVirtualenv(absolute)
        ) {
          continue;
        }
        if (
          CONDITIONAL_BUILD_DIRS.has(entry.name) &&
          isConditionalBuildOutput(absolute, entry.name)
        ) {
          continue;
        }
        if (ig.ignores(`${rel}/`)) continue;
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;

      const dot = entry.name.lastIndexOf(".");
      const ext = dot >= 0 ? entry.name.slice(dot).toLowerCase() : "";
      // Symfony/Laravel-style framework config lives under config/: routing
      // tables, the DI container (services.yaml) and package configuration
      // (packages/*.yaml, e.g. fos_rest, serializer) that can define response
      // handlers, exception listeners and validation. Index the whole tree.
      const configYaml = /(?:^|\/)config\/.+\.ya?ml$/.test(rel);
      const language = EXTENSION_LANGUAGE[ext] ?? (configYaml ? "yaml" : undefined);
      if (!language) continue;
      if (!options.includeTests && TEST_FILE.test(rel)) continue;
      if (ig.ignores(rel)) continue;

      let stat;
      try {
        stat = statSync(absolute);
      } catch {
        omitted(rel, "Source file metadata could not be read");
        continue;
      }
      if (stat.size > maxFileBytes) {
        omitted(rel, `Source file exceeds maxFileBytes (${stat.size} > ${maxFileBytes})`);
        continue;
      }

      if (files.length >= maxFiles) throw new Error(`Source file limit exceeded (maxFiles=${maxFiles}); narrow the scan or increase the limit`);
      if (totalBytes + stat.size > maxTotalBytes) throw new Error(`Source byte limit exceeded (maxTotalBytes=${maxTotalBytes}); narrow the scan or increase the limit`);
      let content: string;
      try {
        const raw = readFileSync(absolute);
        if (raw[0] === 0xff && raw[1] === 0xfe) {
          if ((raw.length - 2) % 2) { omitted(rel, "Source file has an incomplete UTF-16 code unit"); continue; }
          content = raw.subarray(2).toString("utf16le");
        }
        else if (raw[0] === 0xfe && raw[1] === 0xff) {
          if ((raw.length - 2) % 2) { omitted(rel, "Source file has an incomplete UTF-16 code unit"); continue; }
          content = Buffer.from(raw.subarray(2)).swap16().toString("utf16le");
        } else content = raw.toString("utf8");
      } catch {
        omitted(rel, "Source file could not be read");
        continue;
      }
      if (content.includes("\u0000")) {
        omitted(rel, "Source file contains binary data and could not be parsed");
        continue;
      }

      totalBytes += stat.size;
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
  return { files, byPath, ...(unresolved.length ? {unresolved} : {}) };
}
