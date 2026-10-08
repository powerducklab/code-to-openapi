import type { GoFile } from './index.js';
import type { TsNode } from '../treesitter/runtime.js';
import { findAll, literalString, positionalArguments } from '../treesitter/ast.js';

/** Resolve constants and straight-line local assignments without executing Go. */
export function goStaticString(node: TsNode | undefined, file: GoFile, seen = new Set<number>()): string | null {
  if (!node || seen.has(node.id) || seen.size >= 32) return null;
  const next = new Set(seen).add(node.id);
  const resolve = (value: TsNode | undefined) => goStaticString(value, file, next);
  const literal = literalString(node);
  if (literal !== null) return literal;
  if (node.type === 'parenthesized_expression') return resolve(node.namedChildren[0]);
  if (node.type === 'binary_expression' && node.children.some(child => child.text === '+')) {
    const left = resolve(node.namedChildren[0]), right = resolve(node.namedChildren[1]);
    return left === null || right === null ? null : left + right;
  }
  if (node.type === 'call_expression') {
    const callee = node.namedChildren[0];
    const alias = callee?.namedChildren[0]?.text;
    const imported = findAll(file.root, n => n.type === 'import_spec').some(spec => {
      const path = spec.namedChildren.find(child => child.type.endsWith('string_literal'));
      return literalString(path ?? null) === 'fmt' && (spec.namedChildren.find(child => child.type === 'package_identifier')?.text ?? 'fmt') === alias;
    });
    if (callee?.type !== 'selector_expression' || callee.namedChildren[1]?.text !== 'Sprintf' || !imported) return null;
    const args = positionalArguments(node), format = resolve(args[0]);
    if (format === null || /%(?!s|%)/.test(format.replace(/%%/g, ''))) return null;
    let at = 1, valid = true;
    const result = format.replace(/%%|%s/g, token => {
      if (token === '%%') return '%';
      const value = resolve(args[at++]);
      if (value === null) valid = false;
      return value ?? '';
    });
    return valid && at === args.length ? result : null;
  }
  if (node.type !== 'identifier') return null;
  const assignedValue = (decl: TsNode): TsNode | undefined => {
    if (decl.type === 'const_spec' || decl.type === 'var_spec') {
      const names = decl.namedChildren.filter(child => child.type === 'identifier');
      const at = names.findIndex(child => child.text === node.text);
      return at < 0 ? undefined : decl.namedChildren.find(child => child.type === 'expression_list')?.namedChildren[at];
    }
    const lists = decl.namedChildren.filter(child => child.type === 'expression_list');
    const at = lists[0]?.namedChildren.findIndex(child => child.text === node.text) ?? -1;
    return at < 0 ? undefined : lists[1]?.namedChildren[at];
  };
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (scope.type === 'block') {
      const shadow = findAll(scope, child => child.type === 'var_spec' && child.startIndex < node.startIndex && child.namedChildren.some(name => name.type === 'identifier' && name.text === node.text));
      // Until var declarations and mutations can be jointly ordered, an
      // explicitly declared local must never fall back to a package constant.
      if (shadow.length) return null;
      const writes = findAll(scope, child => ['short_var_declaration', 'assignment_statement', 'inc_statement', 'dec_statement'].includes(child.type))
        .filter(child => child.startIndex < node.startIndex && (assignedValue(child) || child.namedChildren[0]?.text === node.text));
      if (writes.length) {
        // Branches, loops and closures may mutate the same variable. Do not
        // select a conveniently matching assignment across control flow.
        if (writes.some(write => write.parent?.id !== scope!.id || (write.type === 'assignment_statement' && !write.children.some(child => child.text === '=')))) return null;
        return resolve(assignedValue(writes.at(-1)!));
      }
      const constants = findAll(scope, child => child.type === 'const_spec').filter(child => child.parent?.parent?.id === scope!.id && assignedValue(child));
      if (constants.length) return constants.length === 1 ? resolve(assignedValue(constants[0]!)) : null;
    }
    if (['function_declaration', 'method_declaration', 'func_literal'].includes(scope.type)) {
      if (scope.namedChildren.filter(child => child.type === 'parameter_list').some(params => findAll(params, child => child.type === 'identifier' && child.text === node.text).length)) return null;
    }
  }
  const constants = findAll(file.root, child => child.type === 'const_spec')
    .filter(child => child.parent?.parent?.type === 'source_file' && assignedValue(child));
  return constants.length === 1 ? resolve(assignedValue(constants[0]!)) : null;
}
