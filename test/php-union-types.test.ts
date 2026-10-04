import { expect, it } from 'vitest';
import { parseSource } from '../src/lang/treesitter/runtime.js';
import { findAll } from '../src/lang/treesitter/ast.js';
import { buildPhpModelIndex, phpTypeToSchema, docTypeToSchema } from '../src/lang/php/schema.js';

it('preserves nullable and union PHP types without narrowing unknown members', async () => {
  const tree = await parseSource('php', '<?php class Payload { public ?int $id; public string|int $code; public string|null $label; public string|Unknown $unknown; }');
  const model = buildPhpModelIndex({ files: new Map(), classes: new Map(), enums: new Map() });
  const types = findAll(tree, node => node.type === 'property_declaration').map(property =>
    phpTypeToSchema(property.namedChildren.find(node => ['optional_type', 'union_type'].includes(node.type)), model));
  expect(types).toEqual([{type:['integer','null']}, {type:['string','integer']}, {type:['string','null']}, {}]);
  expect(docTypeToSchema('int|null', model, new Set())).toEqual({type:['integer','null']});
  expect(docTypeToSchema('?string', model, new Set())).toEqual({type:['string','null']});
  expect(docTypeToSchema('string|Unknown', model, new Set())).toEqual({});
  expect(docTypeToSchema('Foo&Bar', model, new Set())).toEqual({});
});
