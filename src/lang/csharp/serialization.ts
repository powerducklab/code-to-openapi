import { namespaceComponents } from '../../core/schema-references.js';
export { remapSchemaReferences } from '../../core/schema-references.js';
import type { CSharpAnalysis } from './index.js';
import { findAll } from '../treesitter/ast.js';
import { buildCsModelIndex, type CsModelIndex } from './schema.js';

/** System.Text.Json's output presence is independent of input validation. */
export function buildCsSerializationIndex(analysis: CSharpAnalysis): CsModelIndex {
  const model = buildCsModelIndex(analysis);
  // A global ignore policy can omit any default-valued property. Preserve
  // optional output in that case instead of claiming it is always emitted.
  const globalIgnore = [...analysis.files.values()].some(file => findAll(file.root, node => node.type === 'assignment_expression').some(node =>
    /(?:DefaultIgnoreCondition|IgnoreNullValues)$/.test(node.namedChildren[0]?.text ?? '') &&
    /(?:WhenWritingNull|WhenWritingDefault|true)$/.test(node.namedChildren.at(-1)?.text ?? '')));
  const byName = new Map([...model.byName].map(([name, def]) => {
    const properties = findAll(def.node, node => node.type === 'property_declaration');
    const fields = def.fields.flatMap(field => {
      const property = properties.find(node => node.childForFieldName('name')?.text.toLowerCase() === field.name.toLowerCase());
      const ignore = property ? findAll(property, node => node.type === 'attribute').find(node => /^(?:System\.Text\.Json\.Serialization\.)?JsonIgnore(?:Attribute)?(?:\s*\(|$)/.test(node.text)) : undefined;
      if (ignore && (!ignore.text.includes('Condition') || /\.Always\b/.test(ignore.text))) return [];
      const never = Boolean(ignore && /\.Never\b/.test(ignore.text));
      const conditional = Boolean(ignore && /\.(?:WhenWritingNull|WhenWritingDefault)\b/.test(ignore.text));
      return [{ ...field, required: never || (!conditional && !globalIgnore) }];
    });
    return [name, { ...def, fields }];
  }));
  return { ...model, byName };
}

export function serializedComponents(model: CsModelIndex, reserved: Set<string>) {
  return namespaceComponents(model.components, reserved, 'serialized');
}
