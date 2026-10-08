import { createExternalSourceCollector } from './externalSourceContext.js';
import {sourceFocus,focusedSourceNames} from './sourceFocus.js';
import { sourceExcerpt } from './sourceExcerpt.js';
import { resolve, posix as path } from 'node:path';
import type { TsNode } from '../lang/treesitter/runtime.js';
import type { FileIndex, RouteCandidate } from '../core/types.js';
import type { PhpAnalysis } from '../lang/php/index.js';
import type { TsAnalysis } from '../lang/typescript/index.js';
import { createLanguageSourceGraph, type AdditionalSourceAnalyses } from './languageSourceGraph.js';
import { findAll } from '../lang/treesitter/ast.js';

export interface SourceContext {
  files: Array<{ file: string; contentHash?: string; source: string; truncated: boolean; ranges?: Array<{startLine:number;endLine:number}> }>;
  externalDependencies?: { files: SourceContext["files"]; limitations: string[] };
  unavailable: string[];
  truncated: boolean;
  /** Limits and missing evidence must remain visible to the reviewer/model. */
  limitations?: string[];
}
/** Indexed project source plus bounded installed runtime evidence; never installs or executes dependencies. */
export function createSourceContextBuilder(index: FileIndex, php?: PhpAnalysis, typescript?: TsAnalysis, additional: AdditionalSourceAnalyses = {}) {
  const graph = createLanguageSourceGraph(additional);
  const externalSources = typescript ? createExternalSourceCollector(typescript.ts) : undefined;
  const classes = new Map<string, Set<string>>();
  for (const [file, parsed] of php?.files ?? []) {
    for (const node of findAll(parsed.root, n => ['class_declaration','interface_declaration','trait_declaration','enum_declaration','function_definition'].includes(n.type))) {
      const name = node.namedChildren.find(n => n.type === 'name')?.text;
      if (name) { const key=[parsed.namespace,name].filter(Boolean).join('\\'); const files=classes.get(key)??new Set<string>();files.add(file);classes.set(key,files); }
    }
  }
  const byAbsolute = new Map(index.files.map(file => [resolve(file.absolutePath),file.path]));
  const edges = new Map<string, { local: string[]; missing: string[] }>();
  const dependencies = (file: string, handler?:string) => {
    const edgeKey=file+"\0"+(handler??"");
    if (edges.has(edgeKey)) return edges.get(edgeKey)!;
    const result = { local: [] as string[], missing: [] as string[] };
    const parsed = php?.files.get(file);
    if (parsed) {
      const focus=sourceFocus(parsed.root,handler), used=focusedSourceNames(parsed.root,handler);
      const names = new Set([...parsed.imports].filter(([binding])=>!handler||used.has(binding)).map(([,name])=>name));
      // Same-namespace references need no `use` declaration.
      for (const node of findAll(focus, n => n.type === 'name' || n.type === 'qualified_name')) {
        const text = node.text;
        const parts = text.replace(/^\\/, '').split('\\');
        const alias = parsed.imports.get(parts[0]!);
        const fqcn = text.startsWith('\\') ? text.slice(1)
          : alias ? [alias,...parts.slice(1)].join('\\')
          : [parsed.namespace,text].filter(Boolean).join('\\');
        if (classes.has(fqcn)) names.add(fqcn);
      }
      for (const name of names) {
        const targets = [...(classes.get(name.replace(/^\\/,'')) ?? [])];
        if (targets.length===1) result.local.push(targets[0]!); else result.missing.push((targets.length?'ambiguous: ':'')+name);
      }
    }
    if (parsed) {
      const literalPath=(node:TsNode|undefined,depth=0):string|undefined=>{
        if(!node||depth>16)return;
        if(node.type==='name'&&node.text==='__DIR__')return path.dirname(file);
        if(node.type==='name'&&node.text==='__FILE__')return file;
        if(['string','encapsed_string'].includes(node.type)&&node.namedChildren.every(n=>n.type==='string_content'))return node.text.slice(1,-1);
        if(node.type==='binary_expression'&&node.children.some(n=>n.text==='.')){
          const left=literalPath(node.childForFieldName('left')??undefined,depth+1),right=literalPath(node.childForFieldName('right')??undefined,depth+1);
          if(left!==undefined&&right!==undefined)return left+right;
        }
      };
      for(const include of findAll(parsed.root,n=>['include_expression','include_once_expression','require_expression','require_once_expression'].includes(n.type))){
        const raw=literalPath(include.namedChildren[0]);
        if(raw===undefined){result.missing.push('dynamic PHP include: '+file);continue;}
        // Only paths already present in the source index are eligible.
        const candidates=[path.normalize(raw),path.normalize(path.join(path.dirname(file),raw))].filter(p=>index.byPath.has(p));
        const unique=[...new Set(candidates)];
        if(unique.length===1)result.local.push(unique[0]!);else result.missing.push((unique.length?'ambiguous: ':'')+raw);
      }
    }
    const source = typescript?.sourceByPath.get(file);
    if (source && typescript) {
      const {ts,program} = typescript;
      const imports = new Set<string>();
      const neededNodes = new Set<any>(), usedNames = new Set<string>();
      let focus:any=source;
      if(handler){
        const candidates:any[]=[];
        const locate=(node:any)=>{if(ts.isFunctionLike(node)&&node.getText(source).startsWith(handler))candidates.push(node);ts.forEachChild(node,locate);};
        locate(source);candidates.sort((a,b)=>(a.end-a.pos)-(b.end-b.pos));
        if(candidates.length){focus=candidates[0];for(let parent=focus.parent;parent;parent=parent.parent)if(ts.isClassDeclaration(parent)||ts.isClassExpression(parent)){focus=parent;break;}}
      }
      const pending=[focus],declarations=new Set<any>();
      while(pending.length&&declarations.size<256){
        const declaration=pending.shift();if(declarations.has(declaration))continue;declarations.add(declaration);
        const collect=(node:any)=>{
          if(neededNodes.has(node))return;neededNodes.add(node);
          if(ts.isIdentifier(node)){
            usedNames.add(node.text);
            const symbol=program.getTypeChecker().getSymbolAtLocation(node);
            for(const dep of symbol?.declarations??[])if(dep.getSourceFile()===source&&!declarations.has(dep))pending.push(dep);
          }
          ts.forEachChild(node,collect);
        };collect(declaration);
      }
      if(pending.length)result.missing.push('Same-file symbol traversal budget reached in '+file);
      const visit = (node: any) => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const clause=node.importClause;
          const bindings=[clause?.name?.text,clause?.namedBindings?.name?.text,...(clause?.namedBindings?.elements??[]).map((binding:any)=>binding.name.text)].filter(Boolean);
          if(!handler||!clause||bindings.some((name:string)=>usedNames.has(name)))imports.add(node.moduleSpecifier.text);
        }
        if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) imports.add(node.moduleReference.expression.text);
        if ((!handler||neededNodes.has(node)) && ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
          const symbol = ts.isIdentifier(node.expression) ? program.getTypeChecker().getSymbolAtLocation(node.expression) : undefined;
          const shadowed = symbol?.declarations?.some((decl:any) => !decl.getSourceFile().isDeclarationFile);
          if (shadowed) result.missing.push('Locally shadowed require in '+file);
          else if (node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) imports.add(node.arguments[0].text);
          else result.missing.push('dynamic module dependency in '+file);
        }
        ts.forEachChild(node,visit);
      };
      visit(source);
      for (const specifier of imports) {
        const target = ts.resolveModuleName(specifier,source.fileName,program.getCompilerOptions(),ts.sys).resolvedModule?.resolvedFileName;
        const relative = target && byAbsolute.get(resolve(target));
        if (relative) result.local.push(relative); else result.missing.push(specifier);
      }
    }
    const extra = graph.edges(file,handler);
    result.local.push(...extra.local);result.missing.push(...extra.missing);
    edges.set(edgeKey,result);return result;
  };
  const cache = new Map<string, SourceContext>();
  return (candidate: RouteCandidate): SourceContext => {
    const key = `${candidate.origin.file}\0${candidate.handlerSource}`;
    if (cache.has(key)) return cache.get(key)!;
    // Framework packs append a visible marker to their bounded handler snippets.
    // That marker is not part of the source file and must not break owner lookup.
    const handler = candidate.handlerSource?.replace(/\n(?:\/\/|#) \.\.\. truncated$/, '');
    // Route declarations and handler implementations may live in different files.
    const matches = index.files.filter(file => handler && file.content.includes(handler));
    const originMatch = matches.find(file => file.path === candidate.origin.file);
    const owners = originMatch ? [originMatch] : matches;

    // Prefer the handler dependency graph: registration files can import every controller
    // and consume the entire budget with unrelated routes.
    const roots = owners.length ? owners.map(file => file.path) : [candidate.origin.file].filter((file): file is string => Boolean(file));
    const queue = [...new Set(roots)].map(file => ({file,depth:0}));
    const seen = new Set<string>(), unavailable = new Set<string>();
    const context: SourceContext = { files: [], unavailable: [], truncated: false, limitations: [] };
    if ((handler?.length ?? 0) >= 8192) context.limitations!.push("Handler source was bounded; later branches may be missing.");
    if (!owners.length) context.limitations!.push("Handler source owner could not be located; dependency context may be incomplete.");
    let budget = 24000;
    // Names prioritize evidence only after module resolution has established file identity.
    const preferredNames = new Set(candidate.handlerSource?.match(/[A-Za-z_$][\w$]*/g) ?? []);
    const scores = new Map<string,number>();
    const score = (file:string) => {
      if (!scores.has(file)) scores.set(file,[...preferredNames].reduce((n,name) => n + (index.byPath.get(file)?.content.includes(name) ? 1 : 0),0));
      return scores.get(file)!;
    };
    while (queue.length) {
      const {file,depth} = queue.shift()!;
      if (seen.has(file)) continue;seen.add(file);
      const entry = index.byPath.get(file);
      if (!entry) { unavailable.add(file); continue; }
      if (context.files.length >= 8 || budget <= 0) {context.truncated=true;unavailable.add(file);context.limitations!.push("Source budget reached (8 files / 24000 characters); listed omitted files were not supplied.");continue;}
      // Reserve room for later direct dependencies instead of letting the first
      // four large files exhaust the entire eight-file evidence budget.
      const limit = depth === 0 ? Math.min(6000, budget) : Math.min(6000, Math.floor(budget / Math.max(1, 8 - context.files.length)));
      const excerpt = sourceExcerpt(entry.content,limit,handler,preferredNames,
        php?.files.get(file)?.root ?? graph.roots.get(file),typescript?.sourceByPath.get(file),typescript?.ts);
      const source = excerpt.source;
      // Carry referenced bindings into dependency excerpts so their implementations,
      // rather than just import headers, receive the limited source budget.
      for (const name of source.match(/[A-Za-z_$][\w$]*/g) ?? []) preferredNames.add(name);
      if (!php?.files.has(file) && !typescript?.sourceByPath.has(file) && !graph.roots.has(file)) {
        context.limitations!.push(`Dependency traversal is unavailable for ${file}; only indexed source is included.`);
      }
      budget -= source.length;
      const truncated = excerpt.truncated;
      context.files.push({file,contentHash:entry.hash,source,truncated,ranges:excerpt.ranges});context.truncated ||= truncated;
      const focusedHandler = depth===0 ? handler : undefined;
      context.limitations!.push(...graph.edges(file,focusedHandler).limitations);
      const deps = dependencies(file,focusedHandler);
      deps.missing.forEach(name => unavailable.add(name));
      const targets = [...new Set(deps.local)].sort((a,b) => {
        return score(b)-score(a)||a.localeCompare(b);
      });
      for (const target of targets) {
        if (seen.has(target)) continue;
        if (depth < 6) queue.push({file:target,depth:depth+1});
        else {context.truncated=true;unavailable.add(target);context.limitations!.push("Dependency traversal depth limit reached (6).");}
      }
    }
    if (owners.length > 1) context.limitations!.push("Multiple files match the handler source; ownership is ambiguous.");
    context.unavailable = [...unavailable].slice(0,100); context.truncated ||= unavailable.size > 100;
    context.limitations = [...new Set(context.limitations)];
    if (externalSources) context.externalDependencies = externalSources(context.files.flatMap(file => {
      const entry = index.byPath.get(file.file);
      return entry ? [{file: entry.absolutePath, source: file.source}] : [];
    }));
    cache.set(key,context);return context;
  };
}
