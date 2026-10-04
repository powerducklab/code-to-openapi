import type { JsonSchema } from './types.js';

/** Rewrite only schema references, never property values or descriptions. */
export function remapSchemaReferences<T>(value: T, names: Map<string, string>): T {
  if (Array.isArray(value)) return value.map(item => remapSchemaReferences(item, names)) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === '$ref' && typeof item === 'string' && item.startsWith('#/components/schemas/')) {
      const name = names.get(item.slice('#/components/schemas/'.length));
      if (name) return [key, `#/components/schemas/${name}`];
    }
    return [key, remapSchemaReferences(item, names)];
  })) as T;
}

export function namespaceComponents(schemas: Map<string, JsonSchema>, reserved: Set<string>, prefix: string): { names: Map<string,string>; components: {name:string;schema:JsonSchema}[] } {
  const names = new Map<string,string>();
  for (const name of schemas.keys()) {
    const base = `${prefix}_${name}`;
    let candidate = base, suffix = 2;
    while (reserved.has(candidate)) candidate = `${base}_${suffix++}`;
    reserved.add(candidate); names.set(name, candidate);
  }
  return { names, components: [...schemas].map(([name, schema]) => ({name: names.get(name)!, schema: remapSchemaReferences(schema, names)})) };
}
