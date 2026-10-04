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
  /** Explicit JSON name from [JsonPropertyName] / [JsonProperty]. */
  jsonName?: string;
  ignoreJson?:boolean;
  conditionalJson?:boolean;
}

export type CsTypeKind = "class" | "record" | "enum";

export interface CsTypeDef {
  kind: CsTypeKind;
  name: string;
  fields: CsField[];
  enumValues: string[];
  /** Declared generic parameters, e.g. ["T"] for Result<T>. */
  typeParameters: string[];
  /** base_list node (base class and interfaces), if declared. */
  baseList: TsNode | null;
  /** The class/record/enum declaration node itself, for attribute inheritance. */
  node: TsNode;
}

export interface CsFile {
  path: string;
  root: TsNode;
}

export interface CSharpAnalysis {
  files: Map<string, CsFile>;
  declarations?: CsTypeDef[];
  types: Map<string, CsTypeDef>;
}

const TYPE_DECL_TYPES = new Set(["class_declaration", "struct_declaration", "record_declaration", "enum_declaration"]);

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

/** Explicit JSON property name from [JsonPropertyName("x")] or [JsonProperty("x")]. */
function jsonPropertyName(node: TsNode): string | undefined {
  for (const list of childrenOfType(node, "attribute_list")) {
    for (const attr of childrenOfType(list, "attribute")) {
      const id = attr.namedChildren.find((c) => c.type === "identifier");
      if (!id || !/^JsonProperty(Name)?$/.test(id.text)) continue;
      const args = attr.namedChildren.find((c) => c.type === "attribute_argument_list");
      const literal = args ? findFirst(args, (c) => c.type === "string_literal") : null;
      if (literal) {
        const fragment = literal.namedChildren.find((c) => c.type === "string_fragment");
        if (fragment?.text) return fragment.text;
        return literal.text.replace(/^["']|["']$/g, "");
      }
    }
  }
  return undefined;
}

function jsonVisibility(node:TsNode):{ignoreJson?:boolean;conditionalJson?:boolean}{
 for(const list of childrenOfType(node,'attribute_list'))for(const attr of childrenOfType(list,'attribute')){
  const name=attr.namedChildren.find(n=>n.type==='identifier')?.text;
  if(name!=='JsonIgnore'&&name!=='JsonIgnoreAttribute')continue;
  if(/WhenWritingNull|WhenWritingDefault/.test(attr.text))return {conditionalJson:true};
  if(/Never/.test(attr.text))return {};
  if(!attr.text.includes('(')||/Always/.test(attr.text))return {ignoreJson:true};
 }
 return {};
}

function isOptionalMember(typeNode: TsNode, node: TsNode): boolean {
  if (typeNode.type === "nullable_type") return true;
  if (findFirst(node, (c) => c.type === "equals_value_clause")) return true;
  // Property initializers (`int Page { get; init; } = 1;`) appear as a value
  // node after the accessor list rather than an equals_value_clause.
  const accessor = node.namedChildren.find((c) => c.type === "accessor_list");
  const hasInitializer = node.namedChildren.some((c) => {
    if (accessor && c.startPosition.row < accessor.startPosition.row) return false;
    return (
      /literal$/.test(c.type) ||
      c.type === "invocation_expression" ||
      c.type === "array_creation_expression" ||
      c.type === "object_creation_expression" ||
      c.type === "member_access_expression"
    );
  });
  return hasInitializer;
}

export function extractTypeDef(node: TsNode): CsTypeDef | null {
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
    return { kind: "enum", name, fields: [], enumValues, typeParameters: [], baseList: null, node };
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
          jsonName: jsonPropertyName(param),
          ...jsonVisibility(param),
        });
      }
    }
  }

  if (node.type === "class_declaration" || node.type === "struct_declaration" || node.type === "record_declaration") {
    const body = childrenOfType(node, "declaration_list")[0];
    if (body) {
      for (const prop of childrenOfType(body, "property_declaration")) {
        if (hasStaticModifier(prop)) continue;
        // The property name is the last identifier before the accessor list,
        // initializer or expression body. Type identifiers (e.g. Guid Id) come
        // earlier; accessor/initializer expressions must not be mistaken for
        // the name.
        const terminator = prop.namedChildren.find(
          (c) =>
            c.type === "accessor_list" ||
            c.type === "equals_value_clause" ||
            c.type === "expression_body",
        );
        const beforeTerminator = (c: typeof terminator) =>
          !terminator ||
          !c ||
          c.startPosition.row < terminator.startPosition.row ||
          (c.startPosition.row === terminator.startPosition.row &&
            c.startPosition.column < terminator.startPosition.column);
        const nameCandidates = prop.namedChildren.filter(
          (c) => c.type === "identifier" && beforeTerminator(c),
        );
        const fieldName = nameCandidates.pop();
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
          name: lowerFirst(fieldName.text),
          typeNode,
          required: hasRequiredAttribute(prop) || !isOptionalMember(typeNode, prop),
          jsonName: jsonPropertyName(prop),
          ...jsonVisibility(prop),
        });
      }
    }
  }

  return {
    kind: node.type === "record_declaration" ? "record" : "class",
    name,
    fields,
    enumValues: [],
    typeParameters: collectTypeParameters(node),
    baseList: node.namedChildren.find((c) => c.type === "base_list") ?? null,
    node,
  };
}

function collectTypeParameters(node: TsNode): string[] {
  const list = node.namedChildren.find((c) => c.type === "type_parameter_list");
  if (!list) return [];
  return childrenOfType(list, "type_parameter")
    .map((p) => p.namedChildren.find((c) => c.type === "identifier")?.text)
    .filter((x): x is string => Boolean(x));
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
  const declarations:CsTypeDef[]=[];

  const parser = async (source: string) => {
    let normalized = source;
    let root = await parseSource("c_sharp", normalized);
    // Older WASM grammars can consume the next declaration as the body of
    // a modern semicolon-only class. Repair only an AST-recognized class's
    // error boundary, never matching comments/string contents with regex.
    // Replacing an empty body preserves line numbers and class semantics.
    for (let pass = 0; pass < 4; pass++) {
      const offsets = findAll(root, n => n.type === "ERROR" && n.text.startsWith(";") && n.parent?.type === "class_declaration" &&
        ["compilation_unit", "file_scoped_namespace_declaration", "declaration_list"].includes(n.parent.parent?.type ?? ""))
        .map(n => n.startIndex).filter(offset => normalized[offset] === ";");
      if (!offsets.length || offsets.length > 128) break;
      for (const offset of [...new Set(offsets)].sort((a,b) => b-a)) normalized = normalized.slice(0, offset) + "{}" + normalized.slice(offset + 1);
      root = await parseSource("c_sharp", normalized);
    }
    return root;
  };
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
      if(def){
        const error=decl.namedChildren.find(n=>n.type==='ERROR'&&/^<[^;{}]+>$/.test(n.text));
        if(def.kind==='record'&&def.baseList&&error){
          const base=def.baseList.text+error.text;
          const recovered=await parseSource('c_sharp',`class __Recovered ${base} {}`);
          def.baseList=recovered.namedChildren[0]?.namedChildren.find(n=>n.type==='base_list')??def.baseList;
        }
        declarations.push(def);if(!types.has(def.name))types.set(def.name,def);
      }
    }
  }

  if (!files.size) return null;
  return { files, types, declarations };
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
