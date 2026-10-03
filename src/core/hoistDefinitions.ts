/**
 * Hoists JSON Schema draft-07/2020-12 local definition tables
 * (`definitions` / `$defs`) that framework packs emit inside operation
 * schemas (notably Fastify native JSON schemas) into document-level
 * `components.schemas`, rewriting every local `$ref` accordingly.
 *
 * OpenAPI 3.x only resolves references against `components`, so a schema
 * carrying `{ $ref: "#/definitions/Tag" }` would otherwise fail document
 * validation. The transform is pure and framework-neutral.
 */

import type {
  DiscoveredComponent,
  DiscoveredOperation,
  JsonSchema,
} from "./types.js";

type SchemaRecord = Record<string, JsonSchema>;

const LOCAL_DEF_REF = /^#\/(?:definitions|\$defs)\/(.+)$/;
const DEF_KEYS = ["definitions", "$defs"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableKey(value: unknown): string {
  return JSON.stringify(value);
}

function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[-.]/, "_");
  return cleaned || "Schema";
}

function looksLikeSchema(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return [
    "type",
    "$ref",
    "properties",
    "items",
    "oneOf",
    "anyOf",
    "allOf",
    "enum",
    "format",
    "const",
    "required",
  ].some((key) => key in value);
}

/** Iterates every schema attached to an operation. */
function* operationSchemas(
  operation: DiscoveredOperation,
): Generator<{ holder: Record<string, unknown>; key: string }> {
  for (const parameter of operation.parameters ?? []) {
    if (parameter.schema) yield { holder: parameter as unknown as Record<string, unknown>, key: "schema" };
  }
  for (const media of operation.requestBody?.content ?? []) {
    if (media.schema) yield { holder: media as unknown as Record<string, unknown>, key: "schema" };
    if (media.itemSchema) yield { holder: media as unknown as Record<string, unknown>, key: "itemSchema" };
  }
  for (const response of operation.responses ?? []) {
    for (const media of response.content ?? []) {
      if (media.schema) yield { holder: media as unknown as Record<string, unknown>, key: "schema" };
      if (media.itemSchema) yield { holder: media as unknown as Record<string, unknown>, key: "itemSchema" };
    }
  }
}

/**
 * Hoists local definition tables out of every operation schema. Existing
 * document components win on name and content collisions.
 */
export function hoistLocalSchemaDefinitions(
  operations: DiscoveredOperation[],
  existingComponents: DiscoveredComponent[],
): DiscoveredComponent[] {
  // local definition name -> global component name
  const localToGlobal = new Map<string, string>();
  // content hash -> global component name (identical tables are shared)
  const contentToGlobal = new Map<string, string>();
  const hoisted = new Map<string, JsonSchema>();
  const takenNames = new Set(existingComponents.map((component) => component.name));

  const uniqueName = (base: string): string => {
    let candidate = sanitizeName(base);
    let suffix = 2;
    while (takenNames.has(candidate)) {
      candidate = `${sanitizeName(base)}_${suffix++}`;
    }
    takenNames.add(candidate);
    return candidate;
  };

  const register = (localName: string, schema: JsonSchema): string => {
    const known = localToGlobal.get(localName);
    if (known) return known;
    const hash = stableKey(schema);
    const shared = contentToGlobal.get(hash);
    const globalName = shared ?? uniqueName(localName);
    localToGlobal.set(localName, globalName);
    if (!shared) {
      contentToGlobal.set(hash, globalName);
      hoisted.set(globalName, schema);
    }
    return globalName;
  };

  // Pass 1: collect every definition table.
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) collect(item);
      return;
    }
    if (!isRecord(node)) return;
    for (const defKey of DEF_KEYS) {
      const table = node[defKey];
      if (isRecord(table) && Object.values(table).every(looksLikeSchema)) {
        for (const [localName, schema] of Object.entries(table)) {
          register(localName, schema as JsonSchema);
          collect(schema);
        }
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (!DEF_KEYS.includes(key as (typeof DEF_KEYS)[number])) collect(value);
    }
  };

  // Pass 2: rewrite refs and strip the local tables.
  const rewrite = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) rewrite(item);
      return;
    }
    if (!isRecord(node)) return;
    if (typeof node.$ref === "string") {
      const match = LOCAL_DEF_REF.exec(node.$ref);
      if (match) {
        const globalName = localToGlobal.get(match[1]!);
        if (globalName) node.$ref = `#/components/schemas/${globalName}`;
      }
    }
    for (const defKey of DEF_KEYS) {
      const table = node[defKey];
      if (isRecord(table) && Object.values(table).every(looksLikeSchema)) {
        delete node[defKey];
      }
    }
    for (const value of Object.values(node)) rewrite(value);
  };

  const roots: JsonSchema[] = [];
  for (const operation of operations) {
    for (const { holder, key } of operationSchemas(operation)) {
      roots.push(holder[key] as JsonSchema);
    }
  }
  for (const component of existingComponents) roots.push(component.schema);

  for (const root of roots) collect(root);
  for (const root of roots) rewrite(root);
  // Hoisted schemas may reference siblings in the same definition table.
  for (const schema of hoisted.values()) rewrite(schema);

  return [
    ...existingComponents,
    ...[...hoisted.entries()].map(([name, schema]) => ({ name, schema })),
  ];
}
