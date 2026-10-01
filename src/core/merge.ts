/**
 * Three-way merge of a fresh scan into the user's current OpenAPI document.
 *
 * Inputs:
 *   - current:  the OAS document the user has been editing (source of truth for
 *               manual work)
 *   - scanned:  the OAS document produced by the latest scan
 *   - previous: sidecar written after the previous accepted scan (base)
 *   - next:     sidecar produced by the latest scan
 *
 * Rules, deliberately conservative:
 *   - Added routes are inserted.
 *   - Changed routes refresh the structural contract (parameters, request
 *     body, responses, security) while preserving user-authored prose and
 *     examples (summary/description/tags/externalDocs/deprecated/operationId,
 *     parameter and response descriptions/examples, x- extensions).
 *   - Removed routes are NEVER deleted automatically; they stay in the
 *     document and are returned in `removed` so the UI can flag them.
 *   - Components and security schemes are add-only. A scanned component whose
 *     name collides with a different user schema is renamed and its refs are
 *     rewritten.
 *   - info, servers and every other top-level user edit are untouched.
 */

import { diffSidecars, type DiscoverySidecar } from "./sidecar.js";

export interface MergeChange {
  method: string;
  path: string;
}

export interface MergeInput {
  current: Record<string, unknown>;
  scanned: Record<string, unknown>;
  previous: DiscoverySidecar;
  next: DiscoverySidecar;
}

export interface MergeResult {
  document: Record<string, unknown>;
  added: MergeChange[];
  changed: MergeChange[];
  removed: MergeChange[];
  unchanged: number;
}

const HTTP_METHOD_KEYS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);

// User-authored operation-level fields that a structural refresh must keep.
const PRESERVE_OPERATION_KEYS = [
  "summary",
  "description",
  "tags",
  "externalDocs",
  "deprecated",
  "operationId",
];

function clone<T>(value: T): T {
  return value === undefined ? value : (structuredClone(value) as T);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length &&
      a.every((item, index) => deepEqual(item, b[index]))
    );
  }
  if (isRecord(a) && isRecord(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

const REF_PREFIX = "#/components/schemas/";

function rewriteRefs(node: unknown, rename: Map<string, string>): unknown {
  if (Array.isArray(node)) return node.map((item) => rewriteRefs(item, rename));
  if (isRecord(node)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string" && value.startsWith(REF_PREFIX)) {
        const original = value.slice(REF_PREFIX.length);
        out[key] = REF_PREFIX + (rename.get(original) ?? original);
      } else {
        out[key] = rewriteRefs(value, rename);
      }
    }
    return out;
  }
  return node;
}

function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  let suffix = 2;
  while (taken.has(`${name}${suffix}`)) suffix += 1;
  return `${name}${suffix}`;
}

/** Merge a refreshed scanned parameter over the user's existing one. */
function mergeParameter(
  scanned: Record<string, unknown>,
  user: Record<string, unknown>,
): Record<string, unknown> {
  const merged = clone(scanned);
  if (typeof user.description === "string") merged.description = user.description;
  if (user.example !== undefined) merged.example = clone(user.example);
  if (isRecord(user.examples)) merged.examples = clone(user.examples);
  return merged;
}

/** Merge request bodies: scanned contract, user descriptions and examples. */
function mergeRequestBody(
  scanned: Record<string, unknown>,
  user: Record<string, unknown>,
  rename: Map<string, string>,
): Record<string, unknown> {
  const merged = clone(scanned);
  if (typeof user.description === "string") merged.description = user.description;
  const scannedContent = isRecord(scanned.content) ? scanned.content : {};
  const userContent = isRecord(user.content) ? user.content : {};
  const content: Record<string, unknown> = {};
  for (const [mediaType, scannedMedia] of Object.entries(scannedContent)) {
    const mergedMedia = isRecord(scannedMedia) ? clone(scannedMedia) : {};
    const userMedia = userContent[mediaType];
    if (isRecord(userMedia)) {
      if (userMedia.example !== undefined)
        mergedMedia.example = clone(userMedia.example);
      if (isRecord(userMedia.examples))
        mergedMedia.examples = clone(userMedia.examples);
    }
    content[mediaType] = rewriteRefs(mergedMedia, rename);
  }
  // Media types the user documented manually are kept untouched.
  for (const [mediaType, userMedia] of Object.entries(userContent)) {
    if (!(mediaType in content)) content[mediaType] = clone(userMedia);
  }
  merged.content = content;
  return merged;
}

/** Merge responses: scanned statuses refreshed, user-only statuses kept. */
function mergeResponses(
  scanned: Record<string, unknown>,
  user: Record<string, unknown>,
  rename: Map<string, string>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const [status, scannedValue] of Object.entries(scanned)) {
    if (!isRecord(scannedValue)) {
      merged[status] = clone(scannedValue);
      continue;
    }
    const userValue = isRecord(user[status]) ? (user[status] as Record<string, unknown>) : undefined;
    const item = clone(scannedValue);
    if (userValue && typeof userValue.description === "string") {
      item.description = userValue.description;
    }
    if (isRecord(item.content) && userValue && isRecord(userValue.content)) {
      for (const [mediaType, media] of Object.entries(item.content)) {
        const userMedia = userValue.content[mediaType];
        if (isRecord(media) && isRecord(userMedia)) {
          if (userMedia.example !== undefined)
            media.example = clone(userMedia.example);
          if (isRecord(userMedia.examples))
            media.examples = clone(userMedia.examples);
        }
      }
    }
    if (isRecord(item.headers) && userValue && isRecord(userValue.headers)) {
      for (const [name, header] of Object.entries(item.headers)) {
        const userHeader = userValue.headers[name];
        if (isRecord(header) && isRecord(userHeader) && typeof userHeader.description === "string") {
          header.description = userHeader.description;
        }
      }
    }
    merged[status] = rewriteRefs(item, rename);
  }
  for (const [status, value] of Object.entries(user)) {
    if (!(status in merged)) merged[status] = clone(value);
  }
  return merged;
}

function mergeOperation(
  scannedOperation: Record<string, unknown>,
  userOperation: Record<string, unknown> | undefined,
  rename: Map<string, string>,
): Record<string, unknown> {
  // No user copy: insert the scanned operation as-is, only rewriting component
  // refs that were renamed due to collisions with user schemas.
  if (!userOperation) {
    return rewriteRefs(clone(scannedOperation), rename) as Record<string, unknown>;
  }

  const merged = clone(scannedOperation);

  for (const key of PRESERVE_OPERATION_KEYS) {
    if (userOperation[key] !== undefined) merged[key] = clone(userOperation[key]);
  }
  for (const [key, value] of Object.entries(userOperation)) {
    if (key.startsWith("x-")) merged[key] = clone(value);
  }

  // Parameters: scanned contract wins, matched user prose/examples survive,
  // user-only parameters are kept (never silently dropped).
  if (Array.isArray(scannedOperation.parameters) || Array.isArray(userOperation.parameters)) {
    const userParams = new Map<string, Record<string, unknown>>();
    for (const parameter of (userOperation.parameters as unknown[] | undefined) ?? []) {
      if (isRecord(parameter) && typeof parameter.name === "string" && typeof parameter.in === "string") {
        userParams.set(`${parameter.in}:${parameter.name}`, parameter);
      }
    }
    const seen = new Set<string>();
    const parameters: unknown[] = [];
    for (const scannedParameter of (scannedOperation.parameters as unknown[] | undefined) ?? []) {
      if (!isRecord(scannedParameter)) {
        parameters.push(clone(scannedParameter));
        continue;
      }
      const id = `${scannedParameter.in}:${scannedParameter.name}`;
      seen.add(id);
      const userParameter = userParams.get(id);
      parameters.push(
        rewriteRefs(
          userParameter
            ? mergeParameter(
                scannedParameter as Record<string, unknown>,
                userParameter,
              )
            : scannedParameter,
          rename,
        ),
      );
    }
    for (const [id, parameter] of userParams) {
      if (!seen.has(id)) parameters.push(clone(parameter));
    }
    merged.parameters = parameters;
  }

  if (isRecord(scannedOperation.requestBody)) {
    merged.requestBody = mergeRequestBody(
      scannedOperation.requestBody,
      isRecord(userOperation.requestBody) ? userOperation.requestBody : {},
      rename,
    );
  } else if (userOperation.requestBody !== undefined) {
    merged.requestBody = clone(userOperation.requestBody);
  }

  if (isRecord(scannedOperation.responses)) {
    merged.responses = mergeResponses(
      scannedOperation.responses,
      isRecord(userOperation.responses) ? userOperation.responses : {},
      rename,
    );
  }

  if (userOperation.security !== undefined && merged.security === undefined) {
    merged.security = clone(userOperation.security);
  }

  return merged;
}

/**
 * Merge the scanned document into the current document. Pure function: inputs
 * are never mutated.
 */
export function mergeScannedDocument(input: MergeInput): MergeResult {
  const document = clone(input.current);
  if (!isRecord(document.paths)) document.paths = {};
  const currentPaths = document.paths as Record<string, Record<string, unknown>>;
  const scannedPaths = isRecord(input.scanned.paths)
    ? (input.scanned.paths as Record<string, Record<string, unknown>>)
    : {};

  // ---- component collision map (add-only, rename on true collision) ----
  if (!isRecord(document.components)) document.components = {};
  const components = document.components as Record<string, Record<string, unknown>>;
  if (!isRecord(components.schemas)) components.schemas = {};
  const currentSchemas = components.schemas as Record<string, unknown>;
  const scannedComponents = isRecord(input.scanned.components)
    ? (input.scanned.components as Record<string, unknown>)
    : {};
  const scannedSchemas = isRecord(scannedComponents.schemas)
    ? (scannedComponents.schemas as Record<string, unknown>)
    : {};
  const rename = new Map<string, string>();
  const takenNames = new Set(Object.keys(currentSchemas));
  for (const [name, schema] of Object.entries(scannedSchemas)) {
    if (!(name in currentSchemas)) continue;
    if (deepEqual(currentSchemas[name], schema)) continue;
    rename.set(name, uniqueName(name, takenNames));
    takenNames.add(rename.get(name)!);
  }
  for (const [name, schema] of Object.entries(scannedSchemas)) {
    const finalName = rename.get(name) ?? name;
    if (!(finalName in currentSchemas)) {
      currentSchemas[finalName] = rewriteRefs(clone(schema), rename);
    }
  }
  // Security schemes are add-only.
  if (isRecord(scannedComponents.securitySchemes)) {
    if (!isRecord(components.securitySchemes)) components.securitySchemes = {};
    for (const [name, scheme] of Object.entries(
      scannedComponents.securitySchemes as Record<string, unknown>,
    )) {
      if (!(name in (components.securitySchemes as Record<string, unknown>))) {
        (components.securitySchemes as Record<string, unknown>)[name] = clone(scheme);
      }
    }
  }

  // ---- route classification from sidecar fingerprints ----
  const diff = diffSidecars(input.previous, input.next);
  const added: MergeChange[] = [];
  const changed: MergeChange[] = [];
  const removed: MergeChange[] = [];
  let unchanged = 0;

  const upsertOperation = (
    method: string,
    path: string,
    change: MergeChange,
    list: Array<MergeChange>,
  ) => {
    const scannedPathItem = scannedPaths[path];
    if (!isRecord(scannedPathItem)) return;
    const scannedOperation = scannedPathItem[method];
    if (!isRecord(scannedOperation)) return;
    const currentPathItem = currentPaths[path];
    const userOperation = isRecord(currentPathItem)
      ? currentPathItem[method]
      : undefined;
    const mergedOperation = mergeOperation(
      scannedOperation,
      isRecord(userOperation) ? userOperation : undefined,
      rename,
    );
    if (!isRecord(currentPaths[path])) {
      // New path: take the scanned path item, then place the merged operation.
      currentPaths[path] = clone(scannedPathItem);
      currentPaths[path][method] = mergedOperation;
    } else {
      currentPaths[path][method] = mergedOperation;
    }
    list.push(change);
  };

  for (const routeChange of diff.routeChanges) {
    if (routeChange.kind === "added" && routeChange.current) {
      upsertOperation(
        routeChange.current.method,
        routeChange.current.path,
        { method: routeChange.current.method, path: routeChange.current.path },
        added,
      );
    } else if (routeChange.kind === "changed" && routeChange.current) {
      upsertOperation(
        routeChange.current.method,
        routeChange.current.path,
        { method: routeChange.current.method, path: routeChange.current.path },
        changed,
      );
    } else if (routeChange.kind === "removed" && routeChange.previous) {
      // Never delete: surface for manual review. If the user already removed
      // it from the document there is nothing to keep.
      const pathItem = currentPaths[routeChange.previous.path];
      if (isRecord(pathItem) && pathItem[routeChange.previous.method] !== undefined) {
        removed.push({
          method: routeChange.previous.method,
          path: routeChange.previous.path,
        });
      }
    }
  }

  const changedKeys = new Set(
    [...added, ...changed].map((item) => `${item.method} ${item.path}`),
  );
  for (const route of input.next.routes) {
    if (!changedKeys.has(`${route.method} ${route.path}`)) unchanged += 1;
  }

  return { document, added, changed, removed, unchanged };
}
