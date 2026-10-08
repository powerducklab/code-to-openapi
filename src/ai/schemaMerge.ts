import type { JsonSchema } from "../core/types.js";
import { hasUnknownSchema } from "../core/completeness.js";

/** Fill only unknown leaves. Model output cannot replace proven schema facts. */
export function fillSchemaGaps(
  known: JsonSchema,
  proposed: JsonSchema,
  components: ReadonlyMap<string, JsonSchema>,
): JsonSchema {
  if (Object.keys(known).length === 0) return structuredClone(proposed);
  // When the deterministic leaf is itself incomplete and the model provides
  // a fully gate-complete replacement (for example a noisy stdlib union of
  // untyped arrays replaced by an array of an existing component), take the
  // model subtree wholesale instead of trying to merge incompatible shapes.
  if (
    !known.properties && !known.items && !known.type && !known.$ref &&
    hasUnknownSchema(known, components) &&
    !hasUnknownSchema(proposed, components)
  ) {
    return structuredClone(proposed);
  }
  if (known.type && proposed.type && JSON.stringify(known.type) !== JSON.stringify(proposed.type)) return structuredClone(known);
  const result = structuredClone(known);
  if (known.type === "array" && !known.items && proposed.items) result.items = structuredClone(proposed.items);
  const kp = known.properties as Record<string, JsonSchema> | undefined;
  const pp = proposed.properties as Record<string, JsonSchema> | undefined;
  if (kp && pp) result.properties = Object.fromEntries(Object.entries(kp).map(([name, schema]) =>
    [name, pp[name] ? fillSchemaGaps(schema, pp[name]!, components) : schema]));
  if (known.items && proposed.items && typeof known.items === "object" && typeof proposed.items === "object"
      && !Array.isArray(known.items) && !Array.isArray(proposed.items)) {
    result.items = fillSchemaGaps(known.items as JsonSchema, proposed.items as JsonSchema, components);
  }
  return result;
}
