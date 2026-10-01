/**
 * C# language pack built on tree-sitter (c_sharp grammar).
 *
 * Indexes record declarations, POCO classes and enums so framework packs can
 * turn handler signatures and DTOs into JSON Schema / components.
 */

import { readFileSync } from "node:fs";
import { relative } from "node:path";

import type { FileIndex, LanguagePack, ScanContext } from "../../core/types.js";
import { parseSource, type TsNode } from "../treesitter/runtime.js";
import { childrenOfType, findAll, findFirst } from "../treesitter/ast.js";

export interface CsField {
  name: string;
  typeNode: TsNode;
  required: boolean;
}

export type CsTypeKind = "class" | "record" | "enum";

export interface CsTypeDef {
  kind: CsTypeKind;
  name: string;
  fields: CsField[];
  enumValues: string[];
}

export interface CsFile {
  path: string;
  root: TsNode;
}

export interface CSharpAnalysis {
  files: Map<string, CsFile>;
  types: Map<string, CsTypeDef>;
}

const TYPE_DECL_TYPES = new Set(["class_declaration", "record_declaration", "enum_declaration"]);

function hasStaticModifier(node: TsNode): boolean {
  return node.namedChildren.some(
    (c) => c.type === "modifier" && /static|const/.test(c.text),
  );
}

function hasRequiredAttribute(node: TsNode): boolean {
  const list = node.namedChildren.find((c) => c.type === "attribute_list");
  if (!list) return false;
  return /Required|JsonRequired/.test(list.text);
}

function isOptionalMember(typeNode: TsNode, node: TsNode): boolean {
  if (typeNode.type === "nullable_type") return true;
  if (findFirst(node, (c) => c.type === "equals_value_clause")) return true;
  return false;
}

function extractTypeDef(node: TsNode): CsTypeDef | null {
  const nameNode = node.namedChildren.find((c) => c.type === "identifier");
  if (!nameNode) return null;
  const name = nameNode.text;

  if (node.type === "enum_declaration") {
    const list = childrenOfType(node, "enum_member_declaration_list")[0];
    const enumValues = list
      ? childrenOfType(list, "enum_member_declaration").map(
          (m) => m.namedChildren.find((c) => c.type === "identifier")?.text ?? "",
        ).filter(Boolean)
      : [];
    return { kind: "enum", name, fields: [], enumValues };
  }

  const fields: CsField[] = [];

  if (node.type === "record_declaration") {
    const params = childrenOfType(node, "parameter_list")[0];
    if (params) {
      for (const param of childrenOfType(params, "parameter")) {
        const fieldName = param.namedChildren.filter((c) => c.type === "identifier").pop();
        const typeNode = param.namedChildren.find(
          (c) =>
            c.type === "predefined_type" ||
            c.type === "identifier" ||
            c.type === "generic_name" ||
            c.type === "array_type" ||
            c.type === "nullable_type" ||
            c.type === "qualified_name",
        );
        if (!fieldName || !typeNode) continue;
        fields.push({
          name: lowerFirst(fieldName.text),
          typeNode,
          required: hasRequiredAttribute(param) || !isOptionalMember(typeNode, param),
        });
      }
    }
  }

  if (node.type === "class_declaration" || node.type === "record_declaration") {
    const body = childrenOfType(node, "declaration_list")[0];
    if (body) {
      for (const prop of childrenOfType(body, "property_declaration")) {
        if (hasStaticModifier(prop)) continue;
        const fieldName = prop.namedChildren.find((c) => c.type === "identifier");
        const typeNode = prop.namedChildren.find(
          (c) =>
            c.type === "predefined_type" ||
            c.type === "identifier" ||
            c.type === "generic_name" ||
            c.type === "array_type" ||
            c.type === "nullable_type" ||
            c.type === "qualified_name",
        );
        if (!fieldName || !typeNode) continue;
        fields.push({
          name: fieldName.text,
          typeNode,
          required: hasRequiredAttribute(prop) || !isOptionalMember(typeNode, prop),
        });
      }
    }
  }

  return {
    kind: node.type === "record_declaration" ? "record" : "class",
    name,
    fields,
    enumValues: [],
  };
}

function lowerFirst(value: string): string {
  return value.length ? value.charAt(0).toLowerCase() + value.slice(1) : value;
}

export const createCSharpAnalysis: LanguagePack<CSharpAnalysis>["analyze"] = async (
  ctx: ScanContext,
) => {
  const index: FileIndex = ctx.index;
  const files = new Map<string, CsFile>();
  const types = new Map<string, CsTypeDef>();

  const parser = async (source: string) => parseSource("c_sharp", source);
  for (const file of index.files) {
    if (file.language !== "csharp") continue;
    let root: TsNode;
    try {
      root = await parser(file.content);
    } catch {
      continue;
    }
    files.set(file.path, { path: file.path, root });

    for (const decl of findAll(root, (n) => TYPE_DECL_TYPES.has(n.type))) {
      const def = extractTypeDef(decl);
      if (def && !types.has(def.name)) types.set(def.name, def);
    }
  }

  if (!files.size) return null;
  return { files, types };
};

/** Reads a sibling source file for deeper inspection when needed. */
export function readProjectFile(ctx: ScanContext, rel: string): string | null {
  try {
    return readFileSync(`${ctx.root}/${rel}`, "utf8");
  } catch {
    return null;
  }
}

export function relOf(ctx: ScanContext, absolute: string): string {
  return relative(ctx.root, absolute).split("\\").join("/");
}
