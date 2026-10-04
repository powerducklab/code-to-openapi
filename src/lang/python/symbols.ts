import type {PythonAnalysis} from './index.js';
import type {TsNode} from '../treesitter/runtime.js';

/** Resolve module-level bindings without a project-wide short-name fallback. */
export function pythonBindingResolver(analysis: PythonAnalysis) {
  function moduleFile(owner: string, module: string): string | undefined {
    const relative = module.match(/^\.+/)?.[0].length ?? 0;
    let segments = module.slice(relative).split('.').filter(Boolean);
    if (relative) {
      const parent = owner.split('/').slice(0, -1);
      if (relative > parent.length + 1) return undefined;
      segments = [...parent.slice(0, parent.length - relative + 1), ...segments];
    }
    const path = segments.join('/');
    const candidates = [`${path}.py`, `${path}/__init__.py`];
    const exact = candidates.filter(candidate => analysis.files.has(candidate));
    if (exact.length === 1) return exact[0];
    if (relative || exact.length > 1) return undefined;
    // Support a source root (e.g. src/) only when resolution is unambiguous.
    const suffix = [...analysis.files.keys()].filter(file => candidates.some(candidate => file.endsWith(`/${candidate}`)));
    return suffix.length === 1 ? suffix[0] : undefined;
  }
  function resolve(file: string, name: string, seen = new Set<string>()): {file: string; name: string} | undefined {
    const key = `${file}:${name}`;
    if (seen.has(key) || seen.size > 32) return undefined;
    const next = new Set(seen).add(key);
    const [head, ...tail] = name.split('.');
    const imported = analysis.files.get(file)?.imports.get(head!);
    if (!imported) return tail.length ? undefined : {file, name};
    if (imported.importedName) {
      if (tail.length) {
        const target = moduleFile(file, `${imported.module}${imported.module.endsWith('.') ? '' : '.'}${imported.importedName}`);
        return target ? resolve(target, tail.join('.'), next) : undefined;
      }
      const target = moduleFile(file, imported.module);
      return target ? resolve(target, imported.importedName, next) : undefined;
    }
    if (!tail.length) return undefined;
    // `import pkg.handlers` binds pkg; `import pkg.handlers as h` binds h.
    const expression = name.startsWith(`${imported.module}.`) ? name : `${imported.module}.${tail.join('.')}`;
    const parts = expression.split('.');
    const target = moduleFile(file, parts.slice(0, -1).join('.'));
    return target ? resolve(target, parts.at(-1)!, next) : undefined;
  }
  function fileOf(node: TsNode): string | undefined {
    let root = node;
    while (root.parent) root = root.parent;
    return [...analysis.files.values()].find(file => file.root.id === root.id)?.path;
  }
  return {resolve, fileOf};
}

export function isModuleDefinition(node: TsNode): boolean {
  const parent = node.parent?.type === 'decorated_definition' ? node.parent.parent : node.parent;
  return parent?.type === 'module';
}
