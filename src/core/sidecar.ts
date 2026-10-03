/**
 * Sidecar model persisted at `.powerduck/discovery.json`.
 *
 * It records file hashes and the stable identity of every discovered route so
 * rescans can diff added/changed/removed routes without touching the user's
 * OAS edits. The sidecar is the only place scan provenance is stored; the
 * generated OAS stays clean.
 */

import { createHash } from "node:crypto";

import type { DiscoveredOperation } from "@powerduck/x-to-openapi";

import type { FileEntry } from "./types.js";

export interface SidecarRoute {
  /** Stable identity: `${method} ${fullPath}`. */
  key: string;
  method: string;
  path: string;
  operationId?: string;
  file: string;
  line?: number;
  symbol?: string;
  /** Hash of the handler source plus resolved type fingerprints. */
  fingerprint: string;
}

export interface DiscoverySidecar {
  version: 1;
  scannedAt: string;
  language?: string;
  framework?: string;
  files: Record<string, string>;
  routes: SidecarRoute[];
}

export type RouteChangeKind = "added" | "changed" | "removed";

export interface RouteChange {
  kind: RouteChangeKind;
  current?: SidecarRoute;
  previous?: SidecarRoute;
}

export interface SidecarDiff {
  changedFiles: string[];
  addedFiles: string[];
  removedFiles: string[];
  routeChanges: RouteChange[];
}

/**
 * Computes a minimal three-way view at the file/route level. OAS-level
 * three-way merging (protecting user edits) happens in the host via JSON Patch.
 */
export function diffSidecars(
  previous: DiscoverySidecar | undefined,
  current: DiscoverySidecar,
): SidecarDiff {
  const prevFiles = new Map(Object.entries(previous?.files ?? {}));
  const curFiles = new Map(Object.entries(current.files));

  const addedFiles: string[] = [];
  const removedFiles: string[] = [];
  const changedFiles: string[] = [];

  for (const [path, hash] of curFiles) {
    if (!prevFiles.has(path)) addedFiles.push(path);
    else if (prevFiles.get(path) !== hash) changedFiles.push(path);
  }
  for (const path of prevFiles.keys()) {
    if (!curFiles.has(path)) removedFiles.push(path);
  }

  const prevRoutes = new Map((previous?.routes ?? []).map((r) => [r.key, r]));
  const curRoutes = new Map(current.routes.map((r) => [r.key, r]));
  const routeChanges: RouteChange[] = [];

  for (const [key, route] of curRoutes) {
    const before = prevRoutes.get(key);
    if (!before) routeChanges.push({ kind: "added", current: route });
    else if (before.fingerprint !== route.fingerprint)
      routeChanges.push({ kind: "changed", current: route, previous: before });
  }
  for (const [key, route] of prevRoutes) {
    if (!curRoutes.has(key)) routeChanges.push({ kind: "removed", previous: route });
  }

  return {
    addedFiles: addedFiles.sort(),
    removedFiles: removedFiles.sort(),
    changedFiles: changedFiles.sort(),
    routeChanges,
  };
}

/** Routes that can be re-analyzed incrementally: only changed/new files. */
export function affectedFiles(diff: SidecarDiff): string[] {
  return [...diff.addedFiles, ...diff.changedFiles];
}

/** Compact, ordering-independent contract of one discovered operation. */
function operationContract(operation: DiscoveredOperation, components: Map<string, unknown>): string {
  const referenced = new Map<string, unknown>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const record = value as Record<string, unknown>;
    if (typeof record.$ref === "string" && record.$ref.startsWith("#/components/schemas/")) {
      const name = record.$ref.slice("#/components/schemas/".length).replace(/~1/g, "/").replace(/~0/g, "~");
      if (!referenced.has(name)) {
        const schema = components.get(name) ?? null;
        referenced.set(name, schema);
        visit(schema);
      }
    }
    Object.values(record).forEach(visit);
  };
  const { origin, confidence, ...contract } = operation;
  visit(contract);
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]),
    );
    return value;
  };
  return JSON.stringify(canonical({ contract, components: Object.fromEntries(referenced) }));
}

export interface SidecarBuildInput {
  files: FileEntry[];
  operations: DiscoveredOperation[];
  components?: readonly { name: string; schema: unknown }[];
  language?: string;
  framework?: string;
}

/**
 * Build the sidecar snapshot for a completed scan. Each route fingerprint
 * combines its source file hash with its resolved contract, so either handler
 * edits or a changed parameter/response shape surface as "changed".
 */
export function buildSidecar(input: SidecarBuildInput): DiscoverySidecar {
  const files: Record<string, string> = {};
  for (const file of input.files) files[file.path] = file.hash;

  const components = new Map((input.components ?? []).map(c => [c.name, c.schema]));
  const routes: SidecarRoute[] = input.operations.map((operation) => {
    const file = operation.origin?.file ?? "";
    const fingerprint = createHash("sha256")
      .update(files[file] ?? "")
      .update("\u0000")
      .update(operationContract(operation, components))
      .digest("hex");
    return {
      key: `${operation.method} ${operation.path}`,
      method: operation.method,
      path: operation.path,
      ...(operation.operationId ? { operationId: operation.operationId } : {}),
      file,
      ...(typeof operation.origin?.line === "number"
        ? { line: operation.origin.line }
        : {}),
      fingerprint,
    };
  });

  return {
    version: 1,
    scannedAt: new Date().toISOString(),
    ...(input.language ? { language: input.language } : {}),
    ...(input.framework ? { framework: input.framework } : {}),
    files,
    routes,
  };
}
