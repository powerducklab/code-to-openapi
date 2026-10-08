import type { ComponentCatalogEntry, GapRequest } from './gapResolver.js';

/** Bounded, reference-driven context. Schemas are AST facts, never a substitute for missing source. */
export function selectComponentContext(request: Pick<GapRequest, 'contract' | 'handlerSource' | 'componentCatalog'>) {
  const catalog = new Map((request.componentCatalog ?? []).map(entry => [entry.name, entry]));
  const queue: string[] = [];
  const visited = new Set<string>();
  const missing = new Set<string>();
  const entries: ComponentCatalogEntry[] = [];
  const refs = (value: unknown) => {
    const stack: unknown[] = [value];
    const seen = new Set<object>();
    while(stack.length) {
      const node = stack.pop();
      if(!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      for(const [key,child] of Object.entries(node)) {
        if(key === '$ref' && typeof child === 'string' && child.startsWith('#/components/schemas/')) queue.push(child.slice(21).replace(/~1/g,'/').replace(/~0/g,'~'));
        else if(child && typeof child === 'object') stack.push(child);
      }
    }
  };
  refs(request.contract);
  const identifiers = new Set(request.handlerSource.match(/[A-Za-z_$][\w$]*/g) ?? []);
  for(const name of catalog.keys()) if(identifiers.has(name)) queue.push(name);
  let size = 0;
  let truncated = false;
  while(queue.length) {
    const name=queue.shift()!;
    if(visited.has(name)) continue;
    visited.add(name);
    const entry=catalog.get(name);
    if(!entry?.schema) {missing.add(name);continue;}
    const length=JSON.stringify(entry).length;
    if(entries.length >= 24 || size + length > 24000) {truncated=true;missing.add(name);continue;}
    entries.push(entry);size+=length;refs(entry.schema);
  }
  return {components:entries, omittedOrUnavailable:[...missing], truncated, dependencySourceIncluded:false as const};
}
