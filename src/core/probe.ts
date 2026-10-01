import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import type { DependencyManifest, FileIndex } from "./types.js";

/**
 * Reads every supported dependency manifest (package.json, requirements.txt,
 * pyproject.toml, go.mod) and merges dependency names into one map so framework
 * detection does not depend on the ecosystem.
 */
export function probeManifest(root: string, index: FileIndex): DependencyManifest {
  const packages = new Map<string, string>();
  let packageJsonPath: string | undefined;

  // Prefer a root package.json, then any indexed package.json (monorepo leaf).
  const candidates = ["package.json", ...index.files.map((f) => f.path).filter((p) =>
    p.endsWith("package.json") && !p.includes("node_modules"),
  )];

  for (const candidate of [...new Set(candidates)]) {
    try {
      const raw = readFileSync(join(root, candidate), "utf8");
      const json = JSON.parse(raw) as Record<string, unknown>;
      for (const bucket of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]) {
        const table = json[bucket];
        if (table && typeof table === "object") {
          for (const [name, version] of Object.entries(table as Record<string, unknown>)) {
            if (typeof version === "string" && !packages.has(name)) packages.set(name, version);
          }
        }
      }
      packageJsonPath ??= candidate;
    } catch {
      // Unreadable or invalid manifests are simply skipped.
    }
  }

  probePython(root, packages);
  probeGo(root, packages);
  probeJava(root, packages);
  probeCSharp(root, index, packages);
  probeRust(root, packages);
  probePhp(root, packages);

  return { packages, packageJsonPath };
}

function addPackage(packages: Map<string, string>, name: string, version = ""): void {
  const normalized = name.trim().toLowerCase();
  if (normalized && !packages.has(normalized)) packages.set(normalized, version);
}

function probePython(root: string, packages: Map<string, string>): void {
  const requirements = join(root, "requirements.txt");
  if (existsSync(requirements)) {
    try {
      for (const rawLine of readFileSync(requirements, "utf8").split(/\r?\n/)) {
        const line = rawLine.replace(/#.*$/, "").trim();
        if (!line || line.startsWith("-")) continue;
        const match = /^([A-Za-z0-9._-]+)/.exec(line);
        if (match) addPackage(packages, match[1]!, line.slice(match[1]!.length));
      }
    } catch {
      // Ignore unreadable requirements files.
    }
  }

  const pyproject = join(root, "pyproject.toml");
  if (existsSync(pyproject)) {
    try {
      const text = readFileSync(pyproject, "utf8");
      // Dependency lines look like `fastapi = "^0.115"` (Poetry) or
      // `"fastapi>=0.115"` (PEP 621); a line scan avoids a TOML dependency.
      for (const line of text.split(/\r?\n/)) {
        const quoted = /^\s*"([A-Za-z0-9._-]+)[<>=!~^;[]/.exec(line);
        if (quoted) {
          addPackage(packages, quoted[1]!);
          continue;
        }
        const table = /^\s*([A-Za-z0-9._-]+)\s*=\s*"[^"]*"/.exec(line);
        if (table) addPackage(packages, table[1]!);
      }
    } catch {
      // Ignore unreadable pyproject files.
    }
  }
}

function probeGo(root: string, packages: Map<string, string>): void {
  const goMod = join(root, "go.mod");
  if (!existsSync(goMod)) return;
  try {
    const text = readFileSync(goMod, "utf8");
    const requireLine = /^\s*([^\s/][^\s]*\.[^\s]+)\s+(v[^\s]+)/;
    for (const line of text.split(/\r?\n/)) {
      if (line.includes("module ") || line.trim().startsWith("//")) continue;
      const match = requireLine.exec(line);
      if (match) addPackage(packages, match[1]!, match[2]!);
    }
  } catch {
    // Ignore unreadable go.mod files.
  }
}

export function hasAnyDependency(
  manifest: DependencyManifest,
  names: readonly string[],
): boolean {
  return names.some((name) => manifest.packages.has(name));
}

/** Maven pom.xml and Gradle builds: Spring Boot starters, frameworks. */
function probeJava(root: string, packages: Map<string, string>): void {
  const pom = join(root, "pom.xml");
  if (existsSync(pom)) {
    try {
      const text = readFileSync(pom, "utf8");
      for (const match of text.matchAll(
        /<artifactId>\s*([A-Za-z0-9._-]+)\s*<\/artifactId>/g,
      )) {
        addPackage(packages, match[1]!);
      }
    } catch {
      // Ignore unreadable pom files.
    }
  }

  for (const gradle of ["build.gradle", "build.gradle.kts"]) {
    const path = join(root, gradle);
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, "utf8");
      for (const match of text.matchAll(
        /(?:implementation|api|compile|runtimeOnly)\s*(?:\(|\s)\s*["']([^:"']+):([^:"']+)/g,
      )) {
        addPackage(packages, `${match[1]}:${match[2]}`);
      }
    } catch {
      // Ignore unreadable Gradle files.
    }
  }
}

/** .csproj PackageReference entries, including monorepo leaves. */
function probeCSharp(root: string, index: FileIndex, packages: Map<string, string>): void {
  const csprojFiles = index.files
    .map((f) => f.path)
    .filter((p) => p.endsWith(".csproj"));
  for (const candidate of csprojFiles) {
    const path = join(root, candidate);
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, "utf8");
      for (const match of text.matchAll(
        /<PackageReference[^>]*Include\s*=\s*"([^"]+)"[^>]*Version\s*=\s*"([^"]+)"/g,
      )) {
        addPackage(packages, match[1]!, match[2]);
      }
    } catch {
      // Ignore unreadable csproj files.
    }
  }
}

/** Cargo.toml [dependencies] / [dev-dependencies] tables. */
function probeRust(root: string, packages: Map<string, string>): void {
  const cargo = join(root, "Cargo.toml");
  if (!existsSync(cargo)) return;
  try {
    const text = readFileSync(cargo, "utf8");
    const tableNames = new Set([
      "[dependencies]",
      "[dev-dependencies]",
      "[build-dependencies]",
    ]);
    let active = false;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith("[")) {
        active = tableNames.has(line.split("#")[0]!.trim());
        continue;
      }
      if (!active || !line || line.startsWith("#")) continue;
      const match = /^([A-Za-z0-9_-]+)\s*=/.exec(line);
      if (match) addPackage(packages, match[1]!);
    }
  } catch {
    // Ignore unreadable Cargo.toml files.
  }
}

/** composer.json require / require-dev tables. */
function probePhp(root: string, packages: Map<string, string>): void {
  const composer = join(root, "composer.json");
  if (!existsSync(composer)) return;
  try {
    const json = JSON.parse(readFileSync(composer, "utf8")) as Record<string, unknown>;
    for (const bucket of ["require", "require-dev"]) {
      const table = json[bucket];
      if (table && typeof table === "object") {
        for (const [name, version] of Object.entries(table as Record<string, unknown>)) {
          if (typeof version === "string") addPackage(packages, name, version);
        }
      }
    }
  } catch {
    // Ignore unreadable composer.json files.
  }
}
