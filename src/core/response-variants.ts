import type {RouteCandidate, JsonSchema} from './types.js';
type Response = RouteCandidate['responses'][number];

/** Preserve same-status wire alternatives without allowing traversal order to
 * choose the response contract. Unknown alternatives remain unknown. */
export function mergeResponseVariants(first: Response, next: Response): Response {
  const content = (first.content ?? []).map(item => ({...item}));
  for (const item of next.content ?? []) {
    const existing = content.find(candidate => candidate.mediaType === item.mediaType);
    if (!existing) { content.push({...item}); continue; }
    for (const key of ['schema', 'itemSchema'] as const) {
      if (JSON.stringify(existing[key]) === JSON.stringify(item[key])) continue;
      const left = existing[key] ?? {};
      const right = item[key] ?? {};
      const variants: JsonSchema[] = Object.keys(left).length === 1 && Array.isArray(left.anyOf) ? [...left.anyOf as JsonSchema[]] : [left];
      const additions: JsonSchema[] = Object.keys(right).length === 1 && Array.isArray(right.anyOf) ? right.anyOf as JsonSchema[] : [right];
      for (const schema of additions) if (!variants.some(value => JSON.stringify(value) === JSON.stringify(schema))) variants.push(schema);
      existing[key] = {anyOf: variants};
    }
  }
  return {...first, ...(content.length ? {content} : {}), confidence: first.confidence === next.confidence ? first.confidence : 'low'};
}
