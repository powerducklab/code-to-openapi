import { readFileSync, realpathSync, statSync, existsSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { SourceContext } from './sourceContext.js';

type Seed = { file: string; source: string };
/** Read selected installed JavaScript dependencies as evidence, never execute them. */
export function createExternalSourceCollector(ts: any) {
  const parsed = new Map<string, any>();
  const checkers = new WeakMap<object, any>();
  function checker(ast: any) {
    if (!checkers.has(ast)) {
      const host = ts.createCompilerHost({ noLib: true, noResolve: true, allowJs: true });
      host.getSourceFile = (file: string) => file === ast.fileName ? ast : undefined;
      const program = ts.createProgram([ast.fileName], { noLib: true, noResolve: true, allowJs: true }, host);
      checkers.set(ast, program.getTypeChecker());
    }
    return checkers.get(ast);
  }
  const resolveCache = new Map<string, string | undefined>();
  function moduleFile(specifier: string, from: string): string | undefined {
    const key = from + '\0' + specifier;
    if (resolveCache.has(key)) return resolveCache.get(key);
    let target: string | undefined;
    try {
      if (specifier.startsWith('.')) target = createRequire(from).resolve(specifier);
      else if (!specifier.startsWith('node:') && !specifier.startsWith('/') && !specifier.includes('..')) {
        const parts = specifier.split('/');
        const name = parts[0]!.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
        const subpath = '.' + specifier.slice(name.length);
        let dir = dirname(from);
        while (true) {
          const root = join(dir, 'node_modules', name), manifest = join(root, 'package.json');
          if (existsSync(manifest)) {
            if (statSync(manifest).size > 262144) break;
            const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
            const condition = (value: any): string | undefined => {
              if (typeof value === 'string') return value;
              if (!value || typeof value !== 'object' || Array.isArray(value)) return;
              for (const [key, child] of Object.entries(value)) if (['import', 'node', 'default'].includes(key)) {
                const found = condition(child); if (found) return found;
              }
            };
            const exports = pkg.exports;
            let entry = typeof exports === 'object' && exports !== null && Object.keys(exports).some(k => k.startsWith('.'))
              ? condition(exports[subpath]) : subpath === '.' ? condition(exports) : undefined;
            if (!entry && exports && typeof exports === 'object') for (const pattern of Object.keys(exports)) {
              const [prefix, suffix] = pattern.split('*');
              if (suffix !== undefined && subpath.startsWith(prefix!) && subpath.endsWith(suffix)) {
                entry = condition(exports[pattern])?.replaceAll('*', subpath.slice(prefix!.length, suffix ? -suffix.length : undefined));
                if (entry) break;
              }
            }
            if (!entry && !exports) entry = subpath === '.' ? pkg.module ?? pkg.main ?? 'index.js' : subpath.slice(2);
            if (entry) {
              const candidate = resolve(root, entry), rel = relative(root, candidate);
              if (!rel.startsWith('..') && !rel.startsWith(sep)) target = candidate;
            }
            break;
          }
          const parent = dirname(dir); if (parent === dir) break; dir = parent;
        }
      }
      if (target) {
        target = realpathSync(target);
        if (!target.includes(sep + 'node_modules' + sep) || !/\.[cm]?js$/.test(target) || statSync(target).size > 2_000_000) target = undefined;
      }
    } catch { target = undefined; }
    if (resolveCache.size >= 2048) resolveCache.clear();
    resolveCache.set(key, target); return target;
  }
  function source(file: string) {
    if (!parsed.has(file)) {
      if (parsed.size >= 32) parsed.delete(parsed.keys().next().value!);
      try { parsed.set(file, ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)); }
      catch { parsed.set(file, undefined); }
    }
    return parsed.get(file);
  }
  return (seeds: Seed[]): NonNullable<SourceContext['externalDependencies']> => {
    const result: NonNullable<SourceContext['externalDependencies']> = { files: [], limitations: [] };
    const queue: Array<{ file: string; names: string[]; depth: number }> = [];
    const enqueueImports = (ast: any, text: string, depth: number, exactReferences?: Set<string>) => {
      const references = exactReferences ?? new Set<string>();
      const selected = ts.createSourceFile('excerpt.ts', text, ts.ScriptTarget.Latest, true);
      const visit = (node: any) => { if (ts.isImportDeclaration(node) || ts.isTypeNode(node)) return; if (ts.isIdentifier(node)) references.add(node.text); ts.forEachChild(node, visit); }; if (!exactReferences) visit(selected);
      for (const node of ast.statements) {
        if (!ts.isImportDeclaration(node) || !node.importClause || node.importClause.isTypeOnly || !ts.isStringLiteral(node.moduleSpecifier)) continue;
        const clause = node.importClause, names: string[] = [];
        if (clause.name && references.has(clause.name.text)) names.push('default');
        for (const item of clause.namedBindings?.elements ?? []) if (!item.isTypeOnly && references.has(item.name.text)) names.push(item.propertyName?.text ?? item.name.text);
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) && references.has(clause.namedBindings.name.text)) {
          result.limitations.push('Namespace dependency requires narrower symbol evidence: ' + node.moduleSpecifier.text); continue;
        }
        if (!names.length) continue;
        if (!ast.fileName.includes(sep + 'node_modules' + sep) && node.moduleSpecifier.text.startsWith('.')) continue;
        if (isBuiltin(node.moduleSpecifier.text)) continue;
        const file = moduleFile(node.moduleSpecifier.text, ast.fileName);
        if (file) queue.push({ file, names, depth });
        else result.limitations.push('Installed runtime source unavailable: ' + node.moduleSpecifier.text);
      }
    };
    for (const seed of seeds) enqueueImports(ts.createSourceFile(seed.file, seed.source, ts.ScriptTarget.Latest, true), seed.source, 0);
    const seen = new Set<string>(); let budget = 32000;
    while (queue.length && seen.size < 64 && result.files.length < 12 && budget > 0) {
      queue.sort((a, b) => Number(b.names.some(n => /transport|schema/i.test(n))) - Number(a.names.some(n => /transport|schema/i.test(n))));
      const item = queue.shift()!;
      const identity = item.file + ':' + [...item.names].sort().join(','); if (seen.has(identity)) continue; seen.add(identity);
      const ast = source(item.file); if (!ast) continue;
      const symbols = checker(ast), usedImports = new Set<string>();
      const declarations = new Map<string, any>(); const exports = new Map<string, string>();
      for (const node of ast.statements) {
        if (node.name && ts.isIdentifier(node.name)) declarations.set(node.name.text, node);
        if (ts.isVariableStatement(node)) for (const decl of node.declarationList.declarations) if (ts.isIdentifier(decl.name)) declarations.set(decl.name.text, decl);
        if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) for (const symbol of node.exportClause.elements) {
          if (node.moduleSpecifier) {
            if (item.names.includes(symbol.name.text)) { const file = moduleFile(node.moduleSpecifier.text, item.file); if (file && item.depth < 6) queue.push({ file, names: [symbol.propertyName?.text ?? symbol.name.text], depth: item.depth + 1 }); }
          } else exports.set(symbol.name.text, symbol.propertyName?.text ?? symbol.name.text);
        }
        if (node.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.DefaultKeyword) && node.name) exports.set('default', node.name.text);
      }
      const pending = item.names.map(name => exports.get(name) ?? name), included = new Set<string>(), pieces: string[] = [];
      let remaining = Math.min(6500, budget), truncated = false;
      while (pending.length && included.size < 64 && remaining > 80) {
        const name = pending.shift()!; if (included.has(name)) continue; included.add(name);
        const decl = declarations.get(name); if (!decl) continue;
        // Large classes often contain transport parsing far below lifecycle methods.
        const nodes = ts.isClassDeclaration(decl) && decl.getWidth(ast) > remaining
          ? [...decl.members].sort((a: any, b: any) => Number(/parse|body|schema/i.test(b.getText(ast))) - Number(/parse|body|schema/i.test(a.getText(ast)))) : [decl];
        if (nodes[0] !== decl) { const label = '// Selected members of ' + name; pieces.push(label); remaining -= label.length + 2; truncated = true; }
        for (const node of nodes) {
          let text = node.getText(ast);
          if (text.length + 2 > remaining) {
            truncated = true;
            if (nodes[0] === decl || remaining < 1200) continue;
            text = text.slice(0, remaining - 60) + '\n/* remaining member source omitted */';
          }
          pieces.push(text); remaining -= text.length + 2;
          const visit = (child: any) => {
            if (child.getStart(ast) >= node.getStart(ast) + text.length) return;
            if (ts.isIdentifier(child)) {
              const symbol = symbols.getSymbolAtLocation(child);
              for (const declaration of symbol?.declarations ?? []) {
                if (declarations.get(child.text) === declaration && !included.has(child.text)) pending.push(child.text);
                if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isNamespaceImport(declaration)) usedImports.add(child.text);
              }
            }
            ts.forEachChild(child, visit);
          }; visit(node);
        }
      }
      const body = pieces.join('\n');
      const used = usedImports;
      const imports = ast.statements.filter((n: any) => ts.isImportDeclaration(n) && (used.has(n.importClause?.name?.text) || used.has(n.importClause?.namedBindings?.name?.text) || (n.importClause?.namedBindings?.elements ?? []).some((e: any) => used.has(e.name.text)))).map((n: any) => n.getText(ast));
      const mapping = item.names.map(name => name + ' = ' + (exports.get(name) ?? name)).join(', ');
      const assembled = '// Requested exports: ' + mapping + '\n' + imports.join('\n') + '\n' + body;
      const text = assembled.slice(0, budget);
      truncated ||= text.length < assembled.length;
      if (!body) { result.limitations.push('Could not extract runtime exports: ' + item.names.join(', ') + ' in ' + item.file); continue; }
      budget -= text.length;
      result.files.push({ file: item.file, source: text, contentHash: createHash('sha256').update(ast.text).digest('hex'), truncated: truncated || pending.length > 0 });
      if (item.depth < 6) enqueueImports(ast, text, item.depth + 1, usedImports);
      else result.limitations.push('Installed dependency traversal depth reached (6).');
    }
    if (queue.length) result.limitations.push('Installed dependency evidence budget reached (12 excerpts / 32000 characters / 64 symbol groups).');
    result.limitations = [...new Set(result.limitations)]; return result;
  };
}
