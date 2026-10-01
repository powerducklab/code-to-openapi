/**
 * Java language analysis layer (tree-sitter, language agnostic).
 *
 * Indexes record, class and enum declarations so framework packs (Spring Boot)
 * can resolve request/response types into JSON Schema components. No framework
 * knowledge lives here.
 */

import type { ScanContext } from "../../core/types.js";
import { parseSource, type TsNode } from "../treesitter/runtime.js";
import { childrenOfType, findAll, findFirst } from "../treesitter/ast.js";

export interface JavaField {
  readonly name: string;
  readonly typeNode: TsNode;
  readonly required: boolean;
}

export interface JavaTypeDef {
  readonly kind: "record" | "class" | "enum";
  readonly name: string;
  readonly file: string;
  readonly node: TsNode;
  readonly fields: JavaField[];
  readonly enumValues: string[];
}

export interface JavaFile {
  readonly path: string;
  readonly content: string;
  readonly root: TsNode;
  readonly packageName: string;
}

export interface JavaAnalysis {
  readonly id: "java";
  readonly files: Map<string, JavaFile>;
  /** Keyed by simple class name; first declaration wins. */
  readonly types: Map<string, JavaTypeDef>;
}

const REQUIRED_ANNOTATIONS = new Set([
  "NotNull",
  "NotBlank",
  "NotEmpty",
  "NonNull",
  "Nonnull",
]);

const TYPE_NODE_TYPES = new Set([
  "type_identifier",
  "generic_type",
  "array_type",
  "integral_type",
  "floating_point_type",
  "boolean_type",
  "void_type",
  "scoped_identifier",
]);

function modifiersOf(node: TsNode): TsNode[] {
  const mods = node.namedChildren.find((child) => child.type === "modifiers");
  return mods ? mods.namedChildren : [];
}

function hasRequiredAnnotation(node: TsNode): boolean {
  return modifiersOf(node).some((mod) => {
    if (mod.type !== "annotation" && mod.type !== "marker_annotation") return false;
    const name = mod.namedChildren.find((c) => c.type === "identifier");
    return name ? REQUIRED_ANNOTATIONS.has(name.text) : false;
  });
}

function typeNodeOf(node: TsNode): TsNode | null {
  return (
    node.namedChildren.find((child) => TYPE_NODE_TYPES.has(child.type)) ?? null
  );
}

function annotationName(node: TsNode): string | null {
  const id = node.namedChildren.find((c) => c.type === "identifier");
  return id ? id.text : null;
}

function collectRecordParams(node: TsNode): JavaField[] {
  const params = findFirst(node, (n) => n.type === "formal_parameters");
  if (!params) return [];
  const fields: JavaField[] = [];
  for (const param of childrenOfType(params, "formal_parameter")) {
    const typeNode = typeNodeOf(param);
    const nameNode = childrenOfType(param, "identifier").pop();
    if (!typeNode || !nameNode) continue;
    fields.push({
      name: nameNode.text,
      typeNode,
      required: hasRequiredAnnotation(param),
    });
  }
  return fields;
}

function collectClassFields(node: TsNode): JavaField[] {
  const body = childrenOfType(node, "class_body")[0];
  if (!body) return [];
  const fields: JavaField[] = [];
  for (const field of childrenOfType(body, "field_declaration")) {
    const mods = field.namedChildren.find((c) => c.type === "modifiers");
    if (mods && /\bstatic\b/.test(mods.text)) continue;
    const typeNode = typeNodeOf(field);
    if (!typeNode) continue;
    for (const declarator of findAll(field, (n) => n.type === "variable_declarator")) {
      const nameNode = declarator.namedChildren.find((c) => c.type === "identifier");
      if (!nameNode) continue;
      fields.push({
        name: nameNode.text,
        typeNode,
        required: hasRequiredAnnotation(field),
      });
    }
  }
  return fields;
}

function collectEnumValues(node: TsNode): string[] {
  const body = findFirst(node, (n) => n.type === "enum_body");
  if (!body) return [];
  return childrenOfType(body, "enum_constant")
    .map((constant) => constant.namedChildren.find((c) => c.type === "identifier")?.text ?? "")
    .filter(Boolean);
}

function declarationName(node: TsNode): string | null {
  const id = node.namedChildren.find((c) => c.type === "identifier");
  return id ? id.text : null;
}

export async function createJavaAnalysis(
  ctx: ScanContext,
): Promise<JavaAnalysis | null> {
  const javaFiles = ctx.index.files.filter((file) => /\.java$/.test(file.path));
  if (javaFiles.length === 0) return null;

  const files = new Map<string, JavaFile>();
  const types = new Map<string, JavaTypeDef>();

  const registerType = (def: JavaTypeDef) => {
    if (!types.has(def.name)) types.set(def.name, def);
  };

  for (const entry of javaFiles) {
    const root = await parseSource("java", entry.content);
    const packageId = findFirst(root, (n) => n.type === "package_declaration");
    const packageName = packageId ? packageId.namedChildren[0]?.text ?? "" : "";
    const file: JavaFile = {
      path: entry.path,
      content: entry.content,
      root,
      packageName,
    };
    files.set(entry.path, file);

    for (const record of findAll(root, (n) => n.type === "record_declaration")) {
      const name = declarationName(record);
      if (!name) continue;
      registerType({
        kind: "record",
        name,
        file: entry.path,
        node: record,
        fields: collectRecordParams(record),
        enumValues: [],
      });
    }

    for (const cls of findAll(root, (n) => n.type === "class_declaration")) {
      const name = declarationName(cls);
      if (!name) continue;
      registerType({
        kind: "class",
        name,
        file: entry.path,
        node: cls,
        fields: collectClassFields(cls),
        enumValues: [],
      });
    }

    for (const en of findAll(root, (n) => n.type === "enum_declaration")) {
      const name = declarationName(en);
      if (!name) continue;
      registerType({
        kind: "enum",
        name,
        file: entry.path,
        node: en,
        fields: [],
        enumValues: collectEnumValues(en),
      });
    }
  }

  return { id: "java", files, types };
}

export { annotationName, modifiersOf, typeNodeOf, TYPE_NODE_TYPES };
