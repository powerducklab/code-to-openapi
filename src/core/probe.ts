import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { DependencyManifest, FileIndex } from "./types.js";

/**
 * Reads the closest package.json manifest and merges every dependency bucket
 * so framework detection does not depend on where a package was declared.
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

  return { packages, packageJsonPath };
}

export function hasAnyDependency(
  manifest: DependencyManifest,
  names: readonly string[],
): boolean {
  return names.some((name) => manifest.packages.has(name));
}
