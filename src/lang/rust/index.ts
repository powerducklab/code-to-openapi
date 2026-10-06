/**
 * Rust language pack built on tree-sitter.
 *
 * Indexes named structs, tuple structs and enums so framework packs can turn
 * extractor types (Json<T>, Query<T>, Path<T>) and return types into JSON
 * Schema / components.
 */

import type {
  FileIndex,
  JsonSchema,
  LanguagePack,
  ScanContext,
} from "../../core/types.js";
import { parseSource, type TsNode } from "../treesitter/runtime.js";
import { childrenOfType, findAll, findFirst } from "../treesitter/ast.js";

export interface RustField {
  name: string;
  typeNode: TsNode;
  required: boolean;
  serializeRequired?: boolean;
  skipSerializing?: boolean;
  skipDeserializing?: boolean;
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
  genericDefaults?: Map<string, TsNode>;
  serializationSchema?: JsonSchema;
  enumValues: string[];
}

export interface RustFile {
  path: string;
  root: TsNode;
}

export interface RustAnalysis {
  files: Map<string, RustFile>;
  types: Map<string, RustTypeDef>;
  /** Named functions by unqualified name; modules may each define their own
   *  `router()`, so all same-named functions are retained. */
  functions: Map<string, TsNode[]>;
}

const TYPE_DECL_TYPES = new Set(["struct_item", "enum_item"]);

const serializers = new WeakMap<TsNode, Map<string, JsonSchema>>();
function customSerialization(
  parent: TsNode | null,
  name: string,
): JsonSchema | undefined {
  if (!parent) return;
  let map = serializers.get(parent);
  if (!map) {
    map = new Map();
    serializers.set(parent, map);
    const imported = /use\s+serde::(?:Serialize|\{[^}]*\bSerialize\b)/.test(
      parent.text,
    );
    for (const item of parent.namedChildren) {
      if (item.type !== "impl_item") continue;
      const trait = item.childForFieldName("trait")?.text,
        target = item.childForFieldName("type")?.text;
      if (
        !target ||
        !(trait === "serde::Serialize" || (trait === "Serialize" && imported))
      )
        continue;
      let schema: JsonSchema = {
        description: "Custom Serde serializer requires review",
      };
      const body = item.namedChildren.find(
        (n) => n.type === "declaration_list",
      );
      const fn = body?.namedChildren.find(
        (n) =>
          n.type === "function_item" &&
          n.childForFieldName("name")?.text === "serialize",
      );
      const block = fn?.childForFieldName("body");
      const statements =
        block?.namedChildren.filter((n) => !n.type.includes("comment")) ?? [];
      const expr = statements.length === 1 ? statements[0] : undefined;
      const call =
        expr?.type === "call_expression"
          ? expr
          : expr?.type === "expression_statement"
            ? expr.namedChildren[0]
            : undefined;
      if (call?.type === "call_expression") {
        const callee = call.childForFieldName("function");
        const method = callee?.childForFieldName("field")?.text;
        const receiver = callee?.childForFieldName("value")?.text;
        const params = fn ? functionSerializerParameter(fn) : undefined;
        if (
          params &&
          receiver === params &&
          ["collect_str", "serialize_str"].includes(method ?? "")
        ) {
          schema = { type: "string" };
          if (
            method === "collect_str" &&
            /\.lazy_format\(Format::Rfc3339\)/.test(call.text) &&
            /use\s+time::\{[^}]*\bFormat\b/.test(parent.text)
          )
            schema.format = "date-time";
        }
      }
      map.set(target, schema);
    }
  }
  return map.get(name);
}
function functionSerializerParameter(fn: TsNode): string | undefined {
  const parameters = fn.childForFieldName("parameters");
  const second = parameters?.namedChildren.filter(
    (n) => n.type === "parameter",
  )[0];
  return second?.childForFieldName("pattern")?.text;
}

export function extractTypeDef(node: TsNode): RustTypeDef | null {
  const nameNode = node.namedChildren.find((c) => c.type === "type_identifier");
  if (!nameNode) return null;
  const name = nameNode.text;
  const serializationSchema = customSerialization(node.parent, name);
  const params = childrenOfType(node, "type_parameters").flatMap(
    (list) => list.namedChildren,
  );
  const generics = params.flatMap((p) =>
    p.type === "type_identifier"
      ? [p.text]
      : p.type === "optional_type_parameter" && p.namedChildren[0]
        ? [p.namedChildren[0].text]
        : [],
  );
  const genericDefaults = new Map<string, TsNode>();
  for (const p of params)
    if (
      p.type === "optional_type_parameter" &&
      p.namedChildren[0] &&
      p.namedChildren[1]
    )
      genericDefaults.set(p.namedChildren[0].text, p.namedChildren[1]);
  const siblings = node.parent?.namedChildren ?? [];
  let container = "";
  for (let i = siblings.findIndex((s) => s.id === node.id) - 1; i >= 0; i--) {
    const sibling = siblings[i]!;
    if (sibling.type === "attribute_item")
      container = sibling.text + "\n" + container;
    else if (!sibling.type.includes("comment")) break;
  }
  const renameAll = /rename_all\s*=\s*"([^"]+)"/.exec(container)?.[1];
  const rename = (name: string) => {
    switch (renameAll) {
      case "camelCase":
        return name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      case "PascalCase":
        return name.replace(/(?:^|_)([a-z])/g, (_, c: string) =>
          c.toUpperCase(),
        );
      case "SCREAMING_SNAKE_CASE":
        return name.toUpperCase();
      case "kebab-case":
        return name.replace(/_/g, "-");
      case "SCREAMING-KEBAB-CASE":
        return name.replace(/_/g, "-").toUpperCase();
      case "lowercase":
        return name.toLowerCase();
      case "UPPERCASE":
        return name.toUpperCase();
      default:
        return name;
    }
  };
  const defaulted = /\bserde\s*\([^)]*\bdefault\b/.test(container);

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
    return {
      kind: "enum",
      name,
      fields: [],
      tupleFields: [],
      generics,
      serializationSchema,
      enumValues,
    };
  }

  const namedFields = childrenOfType(node, "field_declaration_list")[0];
  if (namedFields) {
    const fields: RustField[] = [];
    let attributes = "";
    for (const field of namedFields.namedChildren) {
      if (field.type === "attribute_item") {
        if (/^#\[serde\s*\(/.test(field.text)) attributes += field.text + "\n";
        continue;
      }
      if (field.type !== "field_declaration") {
        if (!field.type.includes("comment")) attributes = "";
        continue;
      }
      const serde = attributes;
      attributes = "";
      const fieldName = field.namedChildren.find(
        (c) => c.type === "field_identifier",
      );
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
        name:
          /serde\s*\(\s*rename\s*=\s*"([^"]+)"/.exec(serde)?.[1] ??
          rename(fieldName.text),
        typeNode,
        required:
          !defaulted &&
          !isOption(typeNode) &&
          !/[,(]\s*default\s*(?:=|,|\))/.test(serde),
        serializeRequired: !/\bskip_serializing_if\s*=/.test(serde),
        skipSerializing: /\b(?:skip|skip_serializing)\s*(?:,|\))/.test(serde),
        skipDeserializing: /\b(?:skip|skip_deserializing)\s*(?:,|\))/.test(
          serde,
        ),
      });
    }
    return {
      kind: "struct",
      name,
      fields,
      tupleFields: [],
      generics,
      genericDefaults,
      serializationSchema,
      enumValues: [],
    };
  }

  const tupleFieldsList = childrenOfType(
    node,
    "ordered_field_declaration_list",
  )[0];
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
      genericDefaults,
      serializationSchema,
      enumValues: [],
    };
  }

  // Unit struct.
  return {
    kind: "struct",
    name,
    fields: [],
    tupleFields: [],
    generics,
    genericDefaults,
    serializationSchema,
    enumValues: [],
  };
}

function isOption(typeNode: TsNode): boolean {
  return (
    typeNode.type === "generic_type" &&
    typeNode.namedChildren.find((c) => c.type === "type_identifier")?.text ===
      "Option"
  );
}

export const createRustAnalysis: LanguagePack<RustAnalysis>["analyze"] = async (
  ctx: ScanContext,
) => {
  const index: FileIndex = ctx.index;
  const files = new Map<string, RustFile>();
  const types = new Map<string, RustTypeDef>();
  const functions = new Map<string, TsNode[]>();

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
      if (!name) continue;
      const list = functions.get(name);
      if (list) list.push(fn);
      else functions.set(name, [fn]);
    }
  }

  if (!files.size) return null;
  return { files, types, functions };
};

/** Finds a named field identifier on a node, skipping type tokens. */
export function fieldName(node: TsNode): string | null {
  return findFirst(node, (n) => n.type === "field_identifier")?.text ?? null;
}
