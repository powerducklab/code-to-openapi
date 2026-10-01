/**
 * Rust language pack built on tree-sitter.
 *
 * Indexes named structs, tuple structs and enums so framework packs can turn
 * extractor types (Json<T>, Query<T>, Path<T>) and return types into JSON
 * Schema / components.
 */

import type { FileIndex, LanguagePack, ScanContext } from "../../core/types.js";
import { parseSource, type TsNode } from "../treesitter/runtime.js";
import { childrenOfType, findAll, findFirst } from "../treesitter/ast.js";

export interface RustField {
  name: string;
  typeNode: TsNode;
  required: boolean;
}

export type RustTypeKind = "struct" | "tuple-struct" | "enum";

export interface RustTypeDef {
  kind: RustTypeKind;
  name: string;
  fields: RustField[];
  /** Tuple struct positional field types. */
  tupleFields: TsNode[];
  /** Generic parameter names, e.g. ["T"]. */
  generics: string[];
  enumValues: string[];
}

export interface RustFile {
  path: string;
  root: TsNode;
}

export interface RustAnalysis {
  files: Map<string, RustFile>;
  types: Map<string, RustTypeDef>;
  functions: Map<string, TsNode>;
}

const TYPE_DECL_TYPES = new Set(["struct_item", "enum_item"]);

function extractTypeDef(node: TsNode): RustTypeDef | null {
  const nameNode = node.namedChildren.find((c) => c.type === "type_identifier");
  if (!nameNode) return null;
  const name = nameNode.text;
  const generics = childrenOfType(node, "type_parameters")
    .flatMap((list) => childrenOfType(list, "type_identifier"))
    .map((id) => id.text);

  if (node.type === "enum_item") {
    const variantList = childrenOfType(node, "enum_variant_list")[0];
    const enumValues: string[] = [];
    if (variantList) {
      for (const variant of childrenOfType(variantList, "enum_variant")) {
        // Unit variants only; data variants cannot map to a string enum.
        const id = variant.namedChildren.find((c) => c.type === "identifier");
        if (id && variant.namedChildren.length === 1) enumValues.push(id.text);
      }
    }
    return { kind: "enum", name, fields: [], tupleFields: [], generics, enumValues };
  }

  const namedFields = childrenOfType(node, "field_declaration_list")[0];
  if (namedFields) {
    const fields: RustField[] = [];
    for (const field of childrenOfType(namedFields, "field_declaration")) {
      const fieldName = field.namedChildren.find((c) => c.type === "field_identifier");
      const typeNode = field.namedChildren.find(
        (c) =>
          c.type === "type_identifier" ||
          c.type === "generic_type" ||
          c.type === "primitive_type" ||
          c.type === "reference_type" ||
          c.type === "tuple_type" ||
          c.type === "array_type",
      );
      if (!fieldName || !typeNode) continue;
      fields.push({
        name: fieldName.text,
        typeNode,
        required: !isOption(typeNode),
      });
    }
    return { kind: "struct", name, fields, tupleFields: [], generics, enumValues: [] };
  }

  const tupleFieldsList = childrenOfType(node, "ordered_field_declaration_list")[0];
  if (tupleFieldsList) {
    const tupleFields = tupleFieldsList.namedChildren.filter(
      (c) =>
        c.type === "type_identifier" ||
        c.type === "generic_type" ||
        c.type === "primitive_type" ||
        c.type === "reference_type",
    );
    return {
      kind: "tuple-struct",
      name,
      fields: [],
      tupleFields,
      generics,
      enumValues: [],
    };
  }

  // Unit struct.
  return { kind: "struct", name, fields: [], tupleFields: [], generics, enumValues: [] };
}

function isOption(typeNode: TsNode): boolean {
  return (
    typeNode.type === "generic_type" &&
    typeNode.namedChildren.find((c) => c.type === "type_identifier")?.text === "Option"
  );
}

export const createRustAnalysis: LanguagePack<RustAnalysis>["analyze"] = async (
  ctx: ScanContext,
) => {
  const index: FileIndex = ctx.index;
  const files = new Map<string, RustFile>();
  const types = new Map<string, RustTypeDef>();
  const functions = new Map<string, TsNode>();

  for (const file of index.files) {
    if (file.language !== "rust") continue;
    let root: TsNode;
    try {
      root = await parseSource("rust", file.content);
    } catch {
      continue;
    }
    files.set(file.path, { path: file.path, root });

    for (const decl of findAll(root, (n) => TYPE_DECL_TYPES.has(n.type))) {
      const def = extractTypeDef(decl);
      if (def && !types.has(def.name)) types.set(def.name, def);
    }
    for (const fn of findAll(root, (n) => n.type === "function_item")) {
      const name = fn.namedChildren.find((c) => c.type === "identifier")?.text;
      if (name && !functions.has(name)) functions.set(name, fn);
    }
  }

  if (!files.size) return null;
  return { files, types, functions };
};

/** Finds a named field identifier on a node, skipping type tokens. */
export function fieldName(node: TsNode): string | null {
  return findFirst(node, (n) => n.type === "field_identifier")?.text ?? null;
}
