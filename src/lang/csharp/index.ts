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
  /** True only when [Required] / [JsonRequired] is explicitly applied. */
  explicitRequired: boolean;
  /** Explicit JSON name from [JsonPropertyName] / [JsonProperty]. */
  jsonName?: string;
  ignoreJson?:boolean;
  conditionalJson?:boolean;
}

export type CsTypeKind = "class" | "record" | "struct" | "enum";

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
          explicitRequired: hasRequiredAttribute(param),
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
          explicitRequired: hasRequiredAttribute(prop),
          required: hasRequiredAttribute(prop) || !isOptionalMember(typeNode, prop),
          jsonName: jsonPropertyName(prop),
          ...jsonVisibility(prop),
        });
      }
    }
  }

  return {
    kind:
      node.type === "record_declaration"
        ? "record"
        : node.type === "struct_declaration"
          ? "struct"
          : "class",
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

/**
 * The vendored c_sharp grammar fails to parse an explicit lambda return type
 * (`async Task<Results<Ok<T>, NotFound>> (int id) => { ... }`), which turns the
 * whole enclosing endpoint call into an ERROR node and drops the route. Strip
 * the return type before parsing so the invocation and lambda parse normally,
 * and preserve the type for block-bodied lambdas as a marker statement
 * (`string __lrt = @"<type>";`) that response inference can read back.
 */
export const LRT_MARKER = "__lrt";

export function normalizeLambdaReturnTypes(source: string): string {
  const isWs = (ch: string | undefined) => ch !== undefined && /\s/.test(ch);
  const arrows: number[] = [];
  // Lightweight lexer: find `=>` arrows while skipping strings and comments.
  for (let i = 0; i < source.length - 1; i++) {
    const ch = source[i];
    if (ch === '"') {
      i++;
      while (i < source.length) {
        if (source[i] === '"') {
          if (source[i + 1] === '"') { i += 2; continue; }
          break;
        }
        if (source[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (ch === "'") {
      i++;
      while (i < source.length && source[i] !== "'") i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i++;
      continue;
    }
    if (ch === "=" && source[i + 1] === ">") arrows.push(i);
  }

  interface Edit {
    typeStart: number;
    typeEnd: number; // exclusive (the '(' of the parameter list)
    injectPos: number | null; // position right after a block body '{'
    rawType: string;
  }
  const edits: Edit[] = [];

  for (const arrow of arrows) {
    // Locate the parameter list immediately before the arrow.
    let p = arrow - 1;
    while (isWs(source[p])) p--;
    if (source[p] !== ")") continue;
    let depth = 1;
    let q = p - 1;
    for (; q >= 0; q--) {
      if (source[q] === ")") depth++;
      else if (source[q] === "(") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue;
    const openParen = q;

    // Distinguish an expression-bodied method (`public Type Name(...) =>`)
    // from a lambda with an explicit return type (`Type (...) =>`). For a
    // method the token right before '(' is the method name, itself preceded by
    // the return type (an identifier or `>`). A lambda's return type directly
    // abuts '(' and is preceded by a boundary or by the `async` keyword.
    let wp = openParen;
    while (isWs(source[wp - 1])) wp--;
    if (/[A-Za-z0-9_]/.test(source[wp - 1] ?? "")) {
      let nameStart = wp;
      while (/[A-Za-z0-9_]/.test(source[nameStart - 1] ?? "")) nameStart--;
      let cb = nameStart - 1;
      while (isWs(source[cb])) cb--;
      let wordEnd = cb;
      while (/[A-Za-z0-9_]/.test(source[wordEnd - 1] ?? "")) wordEnd--;
      const precedingWord = source.slice(wordEnd, cb + 1);
      const precedingChar = source[cb];
      if (precedingWord !== "async" && /[\w>)\]]/.test(precedingChar ?? "")) {
        continue; // A type precedes the name: this is a method, not a lambda.
      }
    }

    // Scan backward over the explicit return type, respecting generic depth.
    let k = openParen;
    while (isWs(source[k - 1])) k--;
    let angleDepth = 0;
    let t = k;
    for (; t > 0; t--) {
      const c = source[t - 1];
      if (c === ">") { angleDepth++; continue; }
      if (c === "<") {
        if (angleDepth === 0) break;
        angleDepth--;
        continue;
      }
      if (angleDepth > 0) {
        // Inside generics: commas, spaces, names and nested types are part of
        // the type argument list.
        if (/[\w\s.\[\]?,]/.test(c)) continue;
        break;
      }
      if (/[,;=}{)]/.test(c)) break;
      if (/[\w\s.\[\]?]/.test(c)) continue;
      break;
    }
    const typeStart = t;
    const rawType = source.slice(typeStart, k).replace(/^\s*async\s+/, "").trim();
    if (!rawType || !/[A-Za-z_]/.test(rawType)) continue;
    // The token before the type must be an argument/declaration boundary; this
    // excludes expression-bodied methods (`public string M(...) =>`).
    let b = typeStart - 1;
    while (isWs(source[b])) b--;
    const boundary = source[b];
    if (boundary !== undefined && !/[,;=}{(]/.test(boundary)) continue;

    // Block body? Find the '{' following the arrow to host the marker.
    let injectPos: number | null = null;
    let z = arrow + 2;
    while (isWs(source[z])) z++;
    if (source[z] === "{") injectPos = z + 1;

    edits.push({ typeStart, typeEnd: openParen, injectPos, rawType });
  }

  if (!edits.length) return source;

  // Apply from the end so earlier offsets stay valid.
  let result = source;
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i]!;
    const marker = e.injectPos !== null ? `string ${LRT_MARKER} = @"${e.rawType}";` : "";
    if (e.injectPos !== null) result = result.slice(0, e.injectPos) + marker + result.slice(e.injectPos);
    result = result.slice(0, e.typeStart) + result.slice(e.typeEnd);
  }
  return result;
}

export const createCSharpAnalysis: LanguagePack<CSharpAnalysis>["analyze"] = async (
  ctx: ScanContext,
) => {
  const index: FileIndex = ctx.index;
  const files = new Map<string, CsFile>();
  const types = new Map<string, CsTypeDef>();
  const declarations:CsTypeDef[]=[];

  const parser = async (source: string) => {
    let normalized = normalizeLambdaReturnTypes(source);
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
