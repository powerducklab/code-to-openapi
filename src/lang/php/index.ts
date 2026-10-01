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
  name: string;
  fqcn: string;
  extends: string | null;
  methods: Map<string, TsNode>;
  /** Constructor promotion and declared public properties. */
  properties: { name: string; typeNode: TsNode; nullable: boolean; hasDefault: boolean }[];
  /** FormRequest rules() entries, when present. */
  formRules: PhpRule[];
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

function parseClass(node: TsNode, namespace: string | null): PhpClass | null {
  const nameNode = node.namedChildren.find((c) => c.type === "name");
  if (!nameNode) return null;
  const name = nameNode.text;
  const base = node.namedChildren.find((c) => c.type === "base_clause");
  const extendsName = base
    ? (base.namedChildren.find((c) => c.type === "name" || c.type === "qualified_name")?.text ?? null)
    : null;

  const methods = new Map<string, TsNode>();
  const properties: PhpClass["properties"] = [];
  let formRules: PhpRule[] = [];

  const body = node.namedChildren.find((c) => c.type === "declaration_list");
  if (body) {
    for (const method of childrenOfType(body, "method_declaration")) {
      const methodName = nodeName(method);
      if (!methodName) continue;
      methods.set(methodName, method);
      if (methodName === "rules") formRules = parseRulesMethod(method);
    }

    for (const prop of childrenOfType(body, "property_declaration")) {
      const variable = findFirst(prop, (c) => c.type === "variable_name");
      const typeNode = prop.namedChildren.find(
        (c) =>
          c.type === "primitive_type" ||
          c.type === "named_type" ||
          c.type === "optional_type" ||
          c.type === "union_type",
      );
      if (!variable || !typeNode) continue;
      properties.push({
        name: variable.text.replace(/^\$/, ""),
        typeNode,
        nullable: typeNode.type === "optional_type",
        hasDefault: Boolean(prop.namedChildren.find((c) => c.type === "assignment_expression")),
      });
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
    name,
    fqcn: namespace ? `${namespace}\\${name}` : name,
    extends: extendsName,
    methods,
    properties,
    formRules,
  };
}

export function parseRulesMethod(method: TsNode): PhpRule[] {
  const rules: PhpRule[] = [];
  // Only the returned top-level array defines rule entries; iterating every
  // nested array would double-count array-form rule values.
  const returned = findAll(method, (n) => n.type === "array_creation_expression");
  const topLevel = returned[0];
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

export const createPhpAnalysis: LanguagePack<PhpAnalysis>["analyze"] = async (
  ctx: ScanContext,
) => {
  const index: FileIndex = ctx.index;
  const files = new Map<string, PhpFile>();
  const classes = new Map<string, PhpClass>();
  const enums = new Map<string, PhpEnum>();

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
        const alias = clause.namedChildren.find((c) => c.type === "name")?.text;
        if (!qualified) continue;
        const fqcn = qualified.text.replace(/^\\/, "");
        const shortName = alias ?? fqcn.split("\\").pop()!;
        imports.set(shortName, fqcn);
      }
    }

    files.set(file.path, { path: file.path, root, namespace, imports });

    for (const classNode of findAll(root, (n) => n.type === "class_declaration")) {
      const cls = parseClass(classNode, namespace);
      if (cls && !classes.has(cls.name)) classes.set(cls.name, cls);
    }
    for (const enumNode of findAll(root, (n) => n.type === "enum_declaration")) {
      const en = parseEnum(enumNode);
      if (en && !enums.has(en.name)) enums.set(en.name, en);
    }
  }

  if (!files.size) return null;
  return { files, classes, enums };
}
