import type {TsNode} from '../treesitter/runtime.js';

const FUNCTION_BOUNDARIES = new Set(['anonymous_function_creation_expression', 'arrow_function', 'function_definition', 'method_declaration', 'class_declaration', 'anonymous_class']);
/** A nested closure's return is not the enclosing controller's return. */
export function belongsToPhpFunction(node: TsNode, owner: TsNode): boolean {
  let parent = node.parent;
  while (parent && parent.id !== owner.id && !FUNCTION_BOUNDARIES.has(parent.type)) parent = parent.parent;
  return parent?.id === owner.id;
}
