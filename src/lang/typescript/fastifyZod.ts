import type { TsAnalysis } from './index.js';
import type { JsonSchema } from '../../core/types.js';
import { resolveStaticValue } from './staticValue.js';
import { convertZodNode } from './zod.js';

/** Resolve fastify-zod's generated $ref by symbol provenance, not variable names.
 * No dependency is executed. Only a statically selected registered schema is read.
 */
export function fastifyZodReference(analysis: TsAnalysis, node: any): JsonSchema | undefined {
  const { ts, checker } = analysis;
  if (!node || !ts.isCallExpression(node) || node.arguments.length !== 1) return;
  const key = resolveStaticValue(analysis, node.arguments[0]);
  if (!key || !ts.isStringLiteralLike(key)) return;
  let symbol = checker.getSymbolAtLocation(node.expression);
  if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const binding = symbol?.valueDeclaration;
  if (!binding || !ts.isBindingElement(binding) ||
      (binding.propertyName?.text ?? binding.name.text) !== '$ref') return;
  const declaration = binding.parent?.parent;
  const factory = declaration?.initializer;
  if (!factory || !ts.isCallExpression(factory)) return;
  const producer = checker.getSymbolAtLocation(factory.expression);
  const imported = producer?.declarations?.some((d: any) =>
    ts.isImportSpecifier(d) && (d.propertyName?.text ?? d.name.text) === 'buildJsonSchemas' &&
    d.parent.parent.parent.moduleSpecifier?.text === 'fastify-zod');
  if (!imported) return;
  const registry = resolveStaticValue(analysis, factory.arguments[0]);
  if (!registry || !ts.isObjectLiteralExpression(registry)) return;
  // A spread or computed key can overwrite the selected registration.
  if (registry.properties.some((p: any) => ts.isSpreadAssignment(p) || ts.isComputedPropertyName(p.name))) return;
  const entries = registry.properties.filter((p: any) => p.name?.text === key.text);
  if (entries.length !== 1) return;
  const entry = entries[0];
  const schemaNode = resolveStaticValue(analysis, ts.isShorthandPropertyAssignment(entry) ? entry.name : entry.initializer);
  if (!schemaNode) return;
  return convertZodNode(schemaNode, {
    ts, sourceFile: schemaNode.getSourceFile(),
    resolveSchemaBinding(name: string, from?: any) {
      const source = from ?? schemaNode.getSourceFile();
      const symbol = checker.getSymbolsInScope(source, ts.SymbolFlags.Value | ts.SymbolFlags.Alias)
        .find((candidate: any) => candidate.name === name);
      const decl = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      return decl?.name ? resolveStaticValue(analysis, decl.name) ?? null : null;
    },
  }) ?? undefined;
}
