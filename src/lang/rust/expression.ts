import type { JsonSchema } from '../../core/types.js';
import type { TsNode } from '../treesitter/runtime.js';
import { findAll } from '../treesitter/ast.js';
import { rustTypeToSchema, type RustModelIndex } from './schema.js';

function binding(node: TsNode, fn: TsNode): TsNode | undefined {
  const ancestors = new Set<number>();
  for (let parent = node.parent; parent; parent = parent.parent) ancestors.add(parent.id);
  const before = (n: TsNode) => n.endPosition.row < node.startPosition.row ||
    (n.endPosition.row === node.startPosition.row && n.endPosition.column < node.startPosition.column);
  const local = findAll(fn, n => n.type === 'let_declaration' && n.childForFieldName('pattern')?.text === node.text && before(n) && Boolean(n.parent && ancestors.has(n.parent.id)))
    .sort((a,b) => b.startIndex-a.startIndex)[0];
  if (local) return local;
  return fn.namedChildren.find(n => n.type === 'parameters')?.namedChildren.find(n => n.type === 'parameter' && n.childForFieldName('pattern')?.text === node.text);
}
function args(node: TsNode): TsNode[] {
  return node.namedChildren.find(n => n.type === 'type_arguments')?.namedChildren.filter(n => n.type !== 'lifetime') ?? [];
}
function name(node: TsNode): string {
  return node.type === 'generic_type' ? node.namedChildren[0]?.text.split('::').pop() ?? '' : node.text.split('::').pop() ?? '';
}
function unalias(node: TsNode | undefined, model: RustModelIndex, depth = 0): TsNode | undefined {
  if (!node || depth > 12) return undefined;
  if (node.type === 'reference_type') return unalias(node.namedChildren.at(-1), model, depth+1);
  if (['type_identifier','generic_type'].includes(node.type) && model.aliases?.has(name(node))) return unalias(model.aliases.get(name(node)), model, depth+1);
  if (node.type === 'generic_type' && ['State','Box','Arc','Rc'].includes(name(node))) return unalias(args(node)[0], model, depth+1);
  return node;
}
function valueType(node: TsNode | undefined, fn: TsNode, model: RustModelIndex, depth = 0): TsNode | undefined {
  if (!node || depth > 12) return undefined;
  if (node.type === 'identifier') {
    const found = binding(node, fn);
    return found?.childForFieldName('type') ?? valueType(found?.childForFieldName('value') ?? undefined, fn, model, depth+1);
  }
  if (node.type === 'await_expression') return valueType(node.namedChildren[0], fn, model, depth+1);
  if (node.type === 'call_expression') {
    const access = node.namedChildren.find(n => n.type === 'field_expression');
    if (access?.namedChildren.at(-1)?.text === 'lock') {
      const receiver = unalias(valueType(access.namedChildren[0], fn, model, depth+1), model);
      if (receiver && name(receiver) === 'Mutex') return args(receiver)[0];
    }
  }
  return undefined;
}

/** Small, evidence-based scalar inference. Never assume arbitrary .len() is usize. */
export function rustScalarExpression(node: TsNode | undefined, fn: TsNode, model: RustModelIndex, depth = 0): JsonSchema {
  if (!node || depth > 12) return {};
  if (node.type === 'identifier') {
    const found = binding(node, fn);
    const type = found?.childForFieldName('type');
    return type ? rustTypeToSchema(type, model) : rustScalarExpression(found?.childForFieldName('value') ?? undefined, fn, model, depth+1);
  }
  if (node.type === 'call_expression') {
    const access = node.namedChildren.find(n => n.type === 'field_expression');
    if (access?.namedChildren.at(-1)?.text === 'len') {
      const receiver = unalias(valueType(access.namedChildren[0], fn, model), model);
      if (receiver && !model.byName.has(name(receiver)) && (['Vec','String','str','HashMap','BTreeMap','HashSet','BTreeSet'].includes(name(receiver)) || receiver.type === 'array_type')) return {type:'integer',format:'int64'};
    }
  }
  if (node.type === 'string_literal') return {type:'string'};
  if (node.type === 'integer_literal') return {type:'integer'};
  if (node.type === 'float_literal') return {type:'number'};
  if (['true','false'].includes(node.text)) return {type:'boolean'};
  return {};
}
