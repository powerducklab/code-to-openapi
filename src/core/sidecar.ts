/**
 * Sidecar model persisted at `.powerduck/discovery.json`.
 *
 * It records file hashes and the stable identity of every discovered route so
 * rescans can diff added/changed/removed routes without touching the user's
 * OAS edits. The sidecar is the only place scan provenance is stored; the
 * generated OAS stays clean.
 */

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
