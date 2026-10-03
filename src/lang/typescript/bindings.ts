/**
 * Cross-file top-level binding resolver for TypeScript/JavaScript sources.
 *
 * Resolves an identifier used in `file` to its initializer node, following
 * local declarations, named/default imports, and `export *` barrels. Only
 * project files are traversed; node_modules and unresolved modules return
 * null so callers can record an honest gap.
 */

export interface BindingResolver {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolve(name: string, from: any): { node: any; file: any } | null;
}

interface BindingHost {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ts: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: any;
  isProjectFile: (fileName: string) => boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function topLevelDeclaration(ts: any, source: any, name: string): any | null {
  let found: any = null;
  source.forEachChild((child: any) => {
    if (found) return;
    if (ts.isVariableStatement(child)) {
      for (const decl of child.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name) {
          found = decl.initializer ?? null;
          return;
        }
      }
    } else if (
      (ts.isFunctionDeclaration(child) ||
        ts.isClassDeclaration(child) ||
        ts.isInterfaceDeclaration(child) ||
        ts.isTypeAliasDeclaration(child)) &&
      child.name?.text === name
    ) {
      found = child;
    }
  });
  return found;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function exportInitializer(ts: any, source: any, exportName: string): any | null {
  let found: any = null;

  const fromObjectBinding = (decl: any): any => {
    // export const a = 1, b = 2 ...
    if (ts.isVariableStatement(decl)) {
      for (const d of decl.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === exportName) return d.initializer ?? null;
      }
    }
    return null;
  };

  source.forEachChild((child: any) => {
    if (found) return;
    const modifiers = child.modifiers ?? [];
    const isExported =
      modifiers.some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword) ||
      ts.isExportDeclaration(child) ||
      ts.isExportAssignment(child);
    if (!isExported) return;

    if (ts.isVariableStatement(child)) {
      found = fromObjectBinding(child);
      return;
    }
    if (
      (ts.isFunctionDeclaration(child) ||
        ts.isClassDeclaration(child) ||
        ts.isInterfaceDeclaration(child) ||
        ts.isTypeAliasDeclaration(child)) &&
      child.name?.text === exportName
    ) {
      found = child;
      return;
    }
    // export default expr
    if (ts.isExportAssignment(child) && !child.isExportEquals && exportName === "default") {
      found = child.expression;
      return;
    }
    // export { local as exportName }
    if (ts.isExportDeclaration(child) && child.exportClause && ts.isNamedExports(child.exportClause)) {
      for (const spec of child.exportClause.elements) {
        if ((spec.name.text === exportName || spec.propertyName?.text === exportName)) {
          const localName = spec.propertyName?.text ?? spec.name.text;
          found = topLevelDeclaration(ts, source, localName);
          return;
        }
      }
    }
  });

  return found;
}

export function createBindingResolver(host: BindingHost): BindingResolver {
  const { ts, program } = host;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const moduleCache = new Map<string, any | null>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exportCache = new Map<string, { node: any; file: any } | null>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resolveModule = (specifier: string, fromFile: any): any | null => {
    const key = `${fromFile.fileName}::${specifier}`;
    if (moduleCache.has(key)) return moduleCache.get(key)!;
    let resolved: any = null;
    if (ts.resolveModuleName) {
      const r = ts.resolveModuleName(
        specifier,
        fromFile.fileName,
        program.getCompilerOptions(),
        ts.sys,
      )?.resolvedModule?.resolvedFileName;
      if (r && host.isProjectFile(r)) resolved = program.getSourceFile(r);
    }
    moduleCache.set(key, resolved);
    return resolved;
  };

  const resolveExport = (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    source: any,
    exportName: string,
    depth = 0,
  ): { node: any; file: any } | null => {
    if (depth > 8 || !source) return null;
    const key = `${source.fileName}::${exportName}`;
    if (exportCache.has(key)) return exportCache.get(key) ?? null;

    let result = exportInitializer(ts, source, exportName);
    let resultFile = source;

    if (!result) {
      // Follow `export * from "./x"` barrels and direct re-export declarations.
      source.forEachChild((child: any) => {
        if (result || !ts.isExportDeclaration(child) || !child.moduleSpecifier) return;
        if (!ts.isStringLiteral(child.moduleSpecifier)) return;
        const target = resolveModule(child.moduleSpecifier.text, source);
        if (!target) return;
        if (child.exportClause && ts.isNamedExports(child.exportClause)) {
          for (const spec of child.exportClause.elements) {
            const exposed = spec.name.text;
            if (exposed === exportName) {
              const inner = spec.propertyName?.text ?? exposed;
              const r = resolveExport(target, inner, depth + 1);
              if (r) {
                result = r.node;
                resultFile = r.file;
              }
            }
          }
        } else if (!child.exportClause) {
          const r = resolveExport(target, exportName, depth + 1);
          if (r) {
            result = r.node;
            resultFile = r.file;
          }
        }
      });
    }

    const out = result ? { node: result, file: resultFile } : null;
    exportCache.set(key, out);
    return out;
  };

  return {
    resolve(name: string, from: any) {
      if (!from) return null;
      const local = topLevelDeclaration(ts, from, name);
      if (local) return { node: local, file: from };

      // Holder object survives TS control-flow narrowing across forEachChild.
      const importRef: { value: { specifier: string; exportName: string } | null } = {
        value: null,
      };
      from.forEachChild((child: any) => {
        if (importRef.value || !ts.isImportDeclaration(child) || !child.importClause) return;
        const clause = child.importClause;
        const specifier = ts.isStringLiteral(child.moduleSpecifier)
          ? child.moduleSpecifier.text
          : null;
        if (!specifier) return;
        if (clause.name?.text === name) {
          importRef.value = { specifier, exportName: "default" };
          return;
        }
        const named = clause.namedBindings;
        if (named && ts.isNamedImports(named)) {
          for (const el of named.elements) {
            if (el.name.text === name) {
              importRef.value = {
                specifier,
                exportName: el.propertyName?.text ?? el.name.text,
              };
              return;
            }
          }
        }
      });

      const importBinding = importRef.value;
      if (!importBinding) return null;
      const target = resolveModule(importBinding.specifier, from);
      if (!target) return null;
      return resolveExport(target, importBinding.exportName);
    },
  };
}
