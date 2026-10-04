/**
 * PHP language pack built on tree-sitter.
 *
 * Indexes classes (methods, promoted constructor properties, declared
 * properties), backed enums and FormRequest rule sets so the Laravel
 * framework pack can resolve request bodies and response models.
 */

import type { FileIndex, LanguagePack, ScanContext } from "../../core/types.js";
import { parseSource, type TsNode } from "../treesitter/runtime.js";
import { childrenOfType, findAll, findFirst } from "../treesitter/ast.js";

export interface PhpRule {
  name: string;
  rules: string;
}

export interface PhpClass {
  node?: TsNode;
  name: string;
  fqcn: string;
  extends: string | null;
  methods: Map<string, TsNode>;
  /** Constructor promotion and declared public properties. */
  properties: { name: string; typeNode: TsNode; nullable: boolean; hasDefault: boolean; promoted?: boolean; visibility?: string }[];
  /** True only for the global PHP JSON serialization interface. */
  jsonSerializable?: boolean;
  /** Docblock @var tag per property name (e.g. "string[]"). */
  propertyDoc: Map<string, string>;
  /** FormRequest rules() entries, when present. */
  formRules: PhpRule[];
  /** Laravel API resource classification. */
  resourceKind: "json-resource" | "resource-collection" | null;
  /** Model class short name referenced by the resource @mixin docblock. */
  mixinModel: string | null;
  /** Class-level @property docblock attributes (Eloquent models). */
  docPropertyTypes: Map<string, string>;
}

export interface PhpEnum {
  name: string;
  backing: "string" | "integer" | null;
  values: { case: string; value: string }[];
}

export interface PhpFile {
  path: string;
  root: TsNode;
  namespace: string | null;
  /** use-import short name -> fully qualified name. */
  imports: Map<string, string>;
}

export interface PhpAnalysis {
  files: Map<string, PhpFile>;
  classes: Map<string, PhpClass>;
  enums: Map<string, PhpEnum>;
}

function nodeName(node: TsNode): string | null {
  return node.namedChildren.find((c) => c.type === "name")?.text ?? null;
}

/** Collect contiguous doc/comment lines immediately above a node. */
function docblockAbove(lines: string[], row: number): string {
  const collected: string[] = [];
  let rowIndex = row - 1;
  let closing = false;
  while (rowIndex >= 0) {
    const line = lines[rowIndex]?.trim() ?? "";
    if (!line) {
      if (collected.length) break;
      rowIndex -= 1;
      continue;
    }
    if (closing || line.endsWith("*/")) {
      closing = !line.startsWith("/**") && !line.startsWith("/*");
      collected.unshift(line);
      if (line.startsWith("/**") || line.startsWith("/*")) break;
      rowIndex -= 1;
      continue;
    }
    if (line.startsWith("//")) {
      collected.unshift(line);
      rowIndex -= 1;
      continue;
    }
    break;
  }
  return collected.join("\n");
}

function parseClass(node: TsNode, namespace: string | null, lines: string[], imports: Map<string, string>): PhpClass | null {
  const nameNode = node.namedChildren.find((c) => c.type === "name");
  if (!nameNode) return null;
  const name = nameNode.text;
  const base = node.namedChildren.find((c) => c.type === "base_clause");
  const extendsName = base
    ? (base.namedChildren.find((c) => c.type === "name" || c.type === "qualified_name")?.text ?? null)
    : null;

  const methods = new Map<string, TsNode>();
  const properties: PhpClass["properties"] = [];
  const propertyDoc = new Map<string, string>();
  let formRules: PhpRule[] = [];

  const classDoc = docblockAbove(lines, node.startPosition.row);
  const mixinMatch = classDoc.match(/@mixin\s+([\\\w]+)/);
  const mixinModel = mixinMatch ? mixinMatch[1]!.split("\\").pop()! : null;

  // Eloquent models declare attributes through class-level @property tags.
  const docPropertyTypes = new Map<string, string>();
  for (const match of classDoc.matchAll(
    /@(?:property|property-read|property-write)\s+([^\s*]+)\s+\$?(\w+)/g,
  )) {
    docPropertyTypes.set(match[2]!, match[1]!);
  }
  const baseShort = extendsName?.split("\\").pop() ?? "";
  const resourceKind: PhpClass["resourceKind"] =
    baseShort === "JsonResource"
      ? "json-resource"
      : baseShort === "ResourceCollection"
        ? "resource-collection"
        : null;

  const body = node.namedChildren.find((c) => c.type === "declaration_list");
  if (body) {
    for (const method of childrenOfType(body, "method_declaration")) {
      const methodName = nodeName(method);
      if (!methodName) continue;
      methods.set(methodName, method);
      if (methodName === "rules") formRules = parseRulesMethod(method);
    }

    for (const prop of childrenOfType(body, "property_declaration")) {
      // Static fields are class state, not JSON instance properties.
      if (prop.namedChildren.some(child => child.type === "static_modifier")) continue;
      const declaredType = prop.namedChildren.find(child => ["primitive_type", "named_type", "optional_type", "union_type"].includes(child.type));
      const doc = docblockAbove(lines, prop.startPosition.row);
      const varMatch = doc.match(/@var\s+([^\s*]+)/);
      for (const element of childrenOfType(prop, "property_element")) {
        const variable = element.namedChildren.find(child => child.type === "variable_name");
        if (!variable) continue;
        const name = variable.text.replace(/^\$/, "");
        if (varMatch) propertyDoc.set(name, varMatch[1]!);
        properties.push({
          name,
          visibility: prop.namedChildren.find(child => child.type === "visibility_modifier")?.text ?? "public",
          // Untyped properties accept any value; their initial value is not a type constraint.
          typeNode: declaredType ?? prop,
          nullable: !declaredType || declaredType.type === "optional_type",
          hasDefault: !declaredType || element.namedChildren.some(child => child.type === "property_initializer"),
        });
      }
    }

    const constructor = methods.get("__construct");
    if (constructor) {
      const params = constructor.namedChildren.find((c) => c.type === "formal_parameters");
      if (params) {
        for (const promoted of childrenOfType(params, "property_promotion_parameter")) {
          const variable = promoted.namedChildren.find((c) => c.type === "variable_name");
          const typeNode = promoted.namedChildren.find(
            (c) =>
              c.type === "primitive_type" ||
              c.type === "named_type" ||
              c.type === "optional_type" ||
              c.type === "union_type",
          );
          if (!variable || !typeNode) continue;
          // A default value is any named node beyond visibility, type and the
          // variable name (null literal, array creation, scalar literal, ...).
          const structural = new Set([
            "visibility_modifier",
            "primitive_type",
            "named_type",
            "optional_type",
            "union_type",
            "variable_name",
          ]);
          const hasDefault = promoted.namedChildren.some(
            (c) => !structural.has(c.type),
          );
          properties.push({
            name: variable.text.replace(/^\$/, ""),
            promoted: true,
            visibility: promoted.namedChildren.find(c => c.type === "visibility_modifier")?.text ?? "public",
            typeNode,
            nullable:
              typeNode.type === "optional_type" ||
              promoted.namedChildren.some((c) => c.type === "null"),
            hasDefault,
          });
        }
      }
    }
  }

  return {
    node,
    name,
    jsonSerializable: node.namedChildren.find(c => c.type === "class_interface_clause")?.namedChildren.some(c => {
      const raw = c.text;
      const resolved = raw.startsWith("\\") ? raw.slice(1) : imports.get(raw) ?? (namespace ? `${namespace}\\${raw}` : raw);
      return resolved === "JsonSerializable";
    }) ?? false,
    fqcn: namespace ? `${namespace}\\${name}` : name,
    extends: extendsName,
    methods,
    properties,
    propertyDoc,
    formRules,
    resourceKind,
    mixinModel,
    docPropertyTypes,
  };
}

export function parseRulesMethod(method: TsNode): PhpRule[] {
  const rules: PhpRule[] = [];
  // Only the returned top-level array defines rule entries; iterating every
  // nested array would double-count array-form rule values.
  const body = method.namedChildren.find(n => n.type === 'compound_statement');
  // A helper's argument array is not a returned validation contract. Keep
  // dynamic/branch-dependent rule builders unresolved instead of guessing.
  const returned = body?.namedChildren.filter(n => n.type === 'return_statement') ?? [];
  const args = method.namedChildren.find(n => n.type === 'arguments');
  const topLevel = method.type === 'method_declaration'
    ? (returned.length === 1 && findAll(body, n => n.type === 'return_statement').length === 1 ? returned[0]!.namedChildren.find(n => n.type === 'array_creation_expression') : undefined)
    : args?.namedChildren.find(n => n.type === 'argument')?.namedChildren.find(n => n.type === 'array_creation_expression');
  if (!topLevel) return rules;
  for (const element of childrenOfType(topLevel, "array_element_initializer")) {
    const strings = childrenOfType(element, "string");
    const key = phpStringText(strings[0]);
    if (!key) continue;
    // Rules accept both string pipes ('required|numeric') and arrays of
    // strings (['required', 'numeric']); normalize to the pipe form.
    const valueArray = element.namedChildren.find(
      (c) => c.type === "array_creation_expression",
    );
    let value: string | null = null;
    if (valueArray) {
      value = findAll(valueArray, (n) => n.type === "string")
        .map((s) => phpStringText(s))
        .filter(Boolean)
        .join("|");
    } else {
      value = phpStringText(strings[1]);
    }
    if (value) rules.push({ name: key, rules: value });
  }
  return rules;
}

function parseEnum(node: TsNode): PhpEnum | null {
  const nameNode = node.namedChildren.find((c) => c.type === "name");
  if (!nameNode) return null;
  const backingType = node.namedChildren.find((c) => c.type === "primitive_type");
  const backing = backingType?.text === "int" ? "integer" : backingType?.text === "string" ? "string" : null;
  const list = node.namedChildren.find((c) => c.type === "enum_declaration_list");
  const values: PhpEnum["values"] = [];
  if (list) {
    for (const enumCase of childrenOfType(list, "enum_case")) {
      const caseName = enumCase.namedChildren.find((c) => c.type === "name")?.text;
      const valueString = enumCase.namedChildren.find((c) => c.type === "string");
      const valueInt = enumCase.namedChildren.find((c) => c.type === "integer");
      if (!caseName) continue;
      values.push({
        case: caseName,
        value: valueString ? phpStringText(valueString) ?? caseName : (valueInt?.text ?? caseName),
      });
    }
  }
  return { name: nameNode.text, backing, values };
}

export function phpStringText(node: TsNode | undefined): string | null {
  if (!node) return null;
  const content = node.namedChildren.find((c) => c.type === "string_content");
  return content ? content.text : node.text.replace(/^['"]|['"]$/g, "");
}

const lexicalFileCache = new WeakMap<PhpAnalysis, Map<number, PhpFile>>();

/** Resolve a class in the lexical file, never by an ambiguous short name. */
export function resolvePhpClass(name: string, analysis: PhpAnalysis, at?: TsNode): PhpClass | undefined {
  let root = at;
  while (root?.parent) root = root.parent;
  let files = lexicalFileCache.get(analysis);
  if (!files) {
    files = new Map([...analysis.files.values()].map(file => [file.root.id, file]));
    lexicalFileCache.set(analysis, files);
  }
  const file = root ? files.get(root.id) : undefined;
  const raw = name.replace(/^\\/, "");
  if (name.startsWith("\\")) return analysis.classes.get(raw);
  if (file) {
    const parts = raw.split("\\");
    const imported = file.imports.get(parts[0]!);
    const qualified = imported ? [imported, ...parts.slice(1)].join("\\") : file.namespace ? `${file.namespace}\\${raw}` : raw;
    return analysis.classes.get(qualified);
  }
  return analysis.classes.get(raw);
}

export function findPhpMethod(cls: PhpClass, name: string, analysis: PhpAnalysis): TsNode | undefined {
  const visited = new Set<string>();
  let current: PhpClass | undefined = cls;
  while (current && !visited.has(current.fqcn) && visited.size < 16) {
    visited.add(current.fqcn);
    const own = current.methods.get(name);
    if (own) return own;
    const context: TsNode | undefined = current.node ?? current.methods.values().next().value;
    current = current.extends ? resolvePhpClass(current.extends, analysis, context) : undefined;
  }
  return undefined;
}

export const createPhpAnalysis: LanguagePack<PhpAnalysis>["analyze"] = async (
  ctx: ScanContext,
) => {
  const index: FileIndex = ctx.index;
  const files = new Map<string, PhpFile>();
  const classes = new Map<string, PhpClass>();
  const enums = new Map<string, PhpEnum>();
  const ambiguous = new Set<string>();

  for (const file of index.files) {
    if (file.language !== "php") continue;
    let root: TsNode;
    try {
      root = await parseSource("php", file.content);
    } catch {
      continue;
    }

    const namespaceNode = findFirst(root, (n) => n.type === "namespace_definition");
    const namespace = namespaceNode
      ? (findFirst(namespaceNode, (n) => n.type === "namespace_name")?.text.replace(/^\\/, "") ?? null)
      : null;

    const imports = new Map<string, string>();
    for (const use of findAll(root, (n) => n.type === "namespace_use_declaration")) {
      for (const clause of childrenOfType(use, "namespace_use_clause")) {
        const qualified = findFirst(clause, (n) => n.type === "qualified_name" || n.type === "name");
        // An explicit alias lives in a namespace_aliasing_clause child; the
        // direct name child of the clause is the last FQCN segment, not the
        // alias (which previously shadowed aliased imports).
        const aliasing = clause.namedChildren.find(
          (c) => c.type === "namespace_aliasing_clause",
        );
        const alias = aliasing?.namedChildren.find((c) => c.type === "name")?.text;
        if (!qualified) continue;
        const fqcn = qualified.text.replace(/^\\/, "");
        const shortName = alias ?? fqcn.split("\\").pop()!;
        imports.set(shortName, fqcn);
      }
    }

    files.set(file.path, { path: file.path, root, namespace, imports });

    for (const classNode of findAll(root, (n) => n.type === "class_declaration" || n.type === "interface_declaration")) {
      const cls = parseClass(classNode, namespace, file.content.split("\n"), imports);
      if (cls) {
        const previous = classes.get(cls.name);
        if (previous && previous.fqcn !== cls.fqcn) {
          ambiguous.add(cls.name);
          classes.delete(cls.name);
        }
        if (!ambiguous.has(cls.name)) classes.set(cls.name, cls);
        classes.set(cls.fqcn, cls);
      }
    }
    for (const enumNode of findAll(root, (n) => n.type === "enum_declaration")) {
      const en = parseEnum(enumNode);
      if (en && !enums.has(en.name)) enums.set(en.name, en);
    }
  }

  if (!files.size) return null;
  return { files, classes, enums };
}
