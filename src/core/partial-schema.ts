import type {JsonSchema} from './types.js';

/** Keep proven structure while recording why the entire contract is not known.
 * Unknown transforms use an unconstrained alternative: known fields remain
 * useful evidence, but are not asserted to survive an opaque serializer.
 */
export function partialSchema(schema: JsonSchema, reason: string, mayTransform = false): JsonSchema {
 const prior = Array.isArray(schema['x-discovery-incomplete']) ? schema['x-discovery-incomplete'] as string[] : [];
 const reasons = [...new Set([...prior, reason])];
 return mayTransform
  ? {anyOf: [schema, {}], 'x-discovery-incomplete': reasons}
  : {...schema, 'x-discovery-incomplete': reasons};
}
