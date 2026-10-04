/**
 * Recursive cleanup for schema trees produced by runtime value inference.
 *
 * Class-based models (for example mysql RowDataPacket subclasses) can make
 * value-flow inference emit a `constructor` data property, and prototype
 * pollution keys (`__proto__`, `prototype`) must never survive into an OpenAPI
 * document. The walk removes those keys from every `properties` map and the
 * matching entries of sibling `required` arrays, leaving genuine schema
 * keywords and enum values untouched.
 */
const PROTOTYPE_HAZARD_KEYS = new Set(["constructor", "__proto__", "prototype"]);

const MAX_DEPTH = 12;

export function stripPrototypeHazards<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripPrototypeHazards(item, depth + 1)) as T;
  }
  const record = value as Record<string, unknown>;
  const properties = record.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    for (const hazard of PROTOTYPE_HAZARD_KEYS) {
      delete (properties as Record<string, unknown>)[hazard];
    }
  }
  if (Array.isArray(record.required)) {
    record.required = record.required.filter(
      (name) => typeof name !== "string" || !PROTOTYPE_HAZARD_KEYS.has(name),
    );
  }
  for (const [key, child] of Object.entries(record)) {
    record[key] = stripPrototypeHazards(child, depth + 1);
  }
  return value;
}
