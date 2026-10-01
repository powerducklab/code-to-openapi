/**
 * Go language analysis layer (tree-sitter, language agnostic).
 *
 * Indexes struct declarations and package-level functions so framework packs
 * (Gin, Chi) can resolve handler bodies and request/response types without
 * re-walking the tree. No framework knowledge lives here.
 */

import type { FileEntry, ScanContext } from "../../core/types.js";
import { parseSource, type TsNode } from "../treesitter/runtime.js";
import { childrenOfType, findAll, findFirst } from "../treesitter/ast.js";

export interface GoField {
  readonly goName: string;
  readonly typeNode: TsNode;
  readonly tag: string | null;
}

export interface GoStruct {
  readonly name: string;
  readonly file: string;
  readonly node: TsNode;
  readonly fields: GoField[];
}

export interface GoFunction {
  readonly name: string;
  readonly file: string;
  readonly node: TsNode;
  readonly body: TsNode | null;
  readonly receiver: TsNode | null;
}

export interface GoFile {
  readonly path: string;
  readonly content: string;
  readonly root: TsNode;
  readonly packageName: string;
}

export interface GoAnalysis {
  readonly id: "go";
  readonly files: Map<string, GoFile>;
  /** Keyed by `${file}::${name}`. */
  readonly structs: Map<string, GoStruct>;
  /** Package-level (non-method) functions by name, across files of the package. */
  readonly functions: Map<string, GoFunction[]>;
}

function parseTag(raw: string | null): string | null {
  if (!raw) return null;
  // raw includes backticks; extract the raw tag body.
  const body = raw.startsWith("`") && raw.endsWith("`") ? raw.slice(1, -1) : raw;
  return body;
}

/** Returns the `json:"..."` tag value and omitempty flag. */
export function jsonTag(field: GoField): {
  name: string | null;
  omitempty: boolean;
} {
  const tag = parseTag(field.tag);
  if (!tag) return { name: null, omitempty: false };
  const match = tag.match(/json:"([^"]*)"/);
  if (!match) return { name: null, omitempty: false };
  const value = match[1];
  if (value === "-") return { name: null, omitempty: false };
  const parts = value.split(",");
  return {
    name: parts[0] || null,
    omitempty: parts.slice(1).includes("omitempty"),
  };
}

/** Returns the `form:"..."` tag value used by Gin binding. */
export function formTag(field: GoField): string | null {
  const tag = parseTag(field.tag);
  if (!tag) return null;
  const match = tag.match(/form:"([^"]*)"/);
  if (!match) return null;
  const value = match[1];
  if (value === "-" || !value) return null;
  return value.split(",")[0];
}

function collectStructs(file: GoFile): GoStruct[] {
  const result: GoStruct[] = [];
  for (const declaration of findAll(file.root, (n) => n.type === "type_declaration")) {
    for (const spec of childrenOfType(declaration, "type_spec")) {
      const nameNode = spec.namedChildren[0];
      const structType = findFirst(
        spec,
        (n) => n.type === "struct_type",
      );
      if (!nameNode || !structType) continue;
      const fieldList = findFirst(structType, (n) => n.type === "field_declaration_list");
      const fields: GoField[] = [];
      if (fieldList) {
        for (const field of childrenOfType(fieldList, "field_declaration")) {
          const names = childrenOfType(field, "field_identifier");
          const typeNode = field.namedChildren.find((child) =>
            [
              "type_identifier",
              "pointer_type",
              "slice_type",
              "array_type",
              "map_type",
              "qualified_type",
              "struct_type",
              "interface_type",
            ].includes(child.type),
          );
          const tagNode = field.namedChildren.find((child) => child.type === "raw_string_literal");
          if (!typeNode) continue;
          if (names.length === 0) {
            // Embedded field.
            fields.push({ goName: typeNode.text.replace(/^\*/, ""), typeNode, tag: null });
            continue;
          }
          for (const name of names) {
            fields.push({
              goName: name.text,
              typeNode,
              tag: tagNode ? tagNode.text : null,
            });
          }
        }
      }
      result.push({ name: nameNode.text, file: file.path, node: structType, fields });
    }
  }
  return result;
}

function collectFunctions(file: GoFile): GoFunction[] {
  const result: GoFunction[] = [];
  for (const node of findAll(file.root, (n) => n.type === "function_declaration")) {
    const children = node.namedChildren;
    // Methods: parameter_list(receiver) precedes the identifier.
    const hasReceiver = children[0]?.type === "parameter_list";
    const nameNode = hasReceiver ? children[1] : children[0];
    if (!nameNode || nameNode.type !== "identifier") continue;
    const receiver = hasReceiver ? children[0] : null;
    const body = findFirst(node, (n) => n.type === "block");
    result.push({ name: nameNode.text, file: file.path, node, body, receiver });
  }
  return result;
}

export async function createGoAnalysis(ctx: ScanContext): Promise<GoAnalysis | null> {
  const goFiles = ctx.index.files.filter((file) => /\.go$/.test(file.path));
  if (goFiles.length === 0) return null;

  const files = new Map<string, GoFile>();
  const structs = new Map<string, GoStruct>();
  const functions = new Map<string, GoFunction[]>();

  for (const entry of goFiles) {
    const root = await parseSource("go", entry.content);
    const packageNode = findFirst(root, (n) => n.type === "package_identifier");
    const file: GoFile = {
      path: entry.path,
      content: entry.content,
      root,
      packageName: packageNode?.text ?? "",
    };
    files.set(entry.path, file);

    for (const struct of collectStructs(file)) {
      structs.set(`${entry.path}::${struct.name}`, struct);
    }
    for (const fn of collectFunctions(file)) {
      if (fn.receiver) continue; // package-level handlers only
      const bucket = functions.get(fn.name) ?? [];
      bucket.push(fn);
      functions.set(fn.name, bucket);
    }
  }

  return { id: "go", files, structs, functions };
}

export type { FileEntry };
