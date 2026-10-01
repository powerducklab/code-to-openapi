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
  /** Explicit Jackson name from @JsonProperty, when present. */
  readonly jsonName?: string;
  readonly typeNode: TsNode;
  readonly required: boolean;
  /** Field is excluded from JSON output by @JsonIgnore. */
  readonly ignored: boolean;
}

export interface JavaTypeDef {
  readonly kind: "record" | "class" | "enum";
  readonly name: string;
  readonly file: string;
  readonly node: TsNode;
  readonly fields: JavaField[];
  readonly enumValues: string[];
  /** Declared class/record type parameters, e.g. ["T"] for CommonResult<T>. */
  readonly typeParameters: string[];
  /** Superclass type node (generic_type or type_identifier), if any. */
  readonly superclass: TsNode | null;
  /** Jackson property naming strategy declared via @JsonNaming. */
  readonly naming: "snake_case" | "default";
  /** Jackson polymorphic types declared with @JsonTypeInfo/@JsonSubTypes. */
  readonly discriminator?: {
    readonly property: string;
    readonly subtypes: ReadonlyArray<{ readonly name: string; readonly type: string }>;
  };
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

function annotationNamed(node: TsNode, name: string): TsNode | null {
  for (const mod of modifiersOf(node)) {
    if (mod.type !== "annotation" && mod.type !== "marker_annotation") continue;
    const id = mod.namedChildren.find((c) => c.type === "identifier");
    if (id && id.text === name) return mod;
  }
  return null;
}

/** Explicit @JsonProperty("name") value on a declaration. */
function jsonPropertyName(node: TsNode): string | undefined {
  const annotation = annotationNamed(node, "JsonProperty");
  if (!annotation) return undefined;
  const literal = findFirst(
    annotation,
    (n) => n.type === "string_literal",
  );
  if (!literal) return undefined;
  const fragment = literal.namedChildren.find((c) => c.type === "string_fragment");
  return fragment ? fragment.text : literal.text.replace(/^"|"$/g, "");
}

function hasJsonIgnore(node: TsNode): boolean {
  return Boolean(annotationNamed(node, "JsonIgnore"));
}

function collectTypeParameters(node: TsNode): string[] {
  const params = node.namedChildren.find((c) => c.type === "type_parameters");
  if (!params) return [];
  return childrenOfType(params, "type_parameter")
    .map((p) => p.namedChildren.find((c) => c.type === "type_identifier")?.text)
    .filter((x): x is string => Boolean(x));
}

function collectSuperclass(node: TsNode): TsNode | null {
  const superNode = node.namedChildren.find((c) => c.type === "superclass");
  if (!superNode) return null;
  return (
    superNode.namedChildren.find(
      (c) =>
        c.type === "generic_type" ||
        c.type === "type_identifier" ||
        c.type === "scoped_identifier",
    ) ?? null
  );
}

function classNamingStrategy(node: TsNode): "snake_case" | "default" {
  const annotation = annotationNamed(node, "JsonNaming");
  return annotation && /SnakeCaseStrategy/.test(annotation.text)
    ? "snake_case"
    : "default";
}

/**
 * Reads Jackson polymorphism declared as
 * `@JsonTypeInfo(use = Id.NAME, property = "x")` together with
 * `@JsonSubTypes({ @Type(value = Sub.class, name = "x"), ... })`.
 * Returns null unless both the discriminator property and at least one
 * resolvable subtype are declared.
 */
function collectDiscriminator(
  node: TsNode,
): { property: string; subtypes: Array<{ name: string; type: string }> } | null {
  const typeInfo = annotationNamed(node, "JsonTypeInfo");
  const subTypes = annotationNamed(node, "JsonSubTypes");
  if (!typeInfo || !subTypes) return null;

  const propertyPair = findFirst(typeInfo, (n) => {
    if (n.type !== "element_value_pair") return false;
    const key = n.namedChildren.find((c) => c.type === "identifier");
    return key?.text === "property";
  });
  const propertyLiteral = propertyPair
    ? findFirst(propertyPair, (n) => n.type === "string_literal")
    : null;
  const property = propertyLiteral
    ? (propertyLiteral.namedChildren.find((c) => c.type === "string_fragment")?.text ??
      propertyLiteral.text.replace(/^"|"$/g, ""))
    : null;
  if (!property) return null;

  const subtypes: Array<{ name: string; type: string }> = [];
  for (const nested of findAll(subTypes, (n) => n.type === "annotation")) {
    const nestedName = annotationName(nested);
    if (!nestedName || !/(^|\.)Type$/.test(nestedName)) continue;
    const valuePair = findFirst(nested, (n) => {
      if (n.type !== "element_value_pair") return false;
      const key = n.namedChildren.find((c) => c.type === "identifier");
      return key?.text === "value";
    });
    const namePair = findFirst(nested, (n) => {
      if (n.type !== "element_value_pair") return false;
      const key = n.namedChildren.find((c) => c.type === "identifier");
      return key?.text === "name";
    });
    const typeNode = valuePair
      ? findFirst(valuePair, (n) => n.type === "type_identifier")
      : null;
    const nameLiteral = namePair
      ? findFirst(namePair, (n) => n.type === "string_literal")
      : null;
    const name = nameLiteral
      ? (nameLiteral.namedChildren.find((c) => c.type === "string_fragment")?.text ??
        nameLiteral.text.replace(/^"|"$/g, ""))
      : null;
    if (typeNode && name) subtypes.push({ name, type: typeNode.text });
  }

  return subtypes.length ? { property, subtypes } : null;
}

function typeNodeOf(node: TsNode): TsNode | null {
  return (
    node.namedChildren.find((child) => TYPE_NODE_TYPES.has(child.type)) ?? null
  );
}

function annotationName(node: TsNode): string | null {
  const id = node.namedChildren.find((c) => c.type === "identifier");
  if (id) return id.text;
  // Scoped names such as JsonSubTypes.Type end in a scoped_identifier whose
  // last identifier child carries the simple name.
  const scoped = node.namedChildren.find((c) => c.type === "scoped_identifier");
  const tail = scoped
    ? scoped.namedChildren.filter((c) => c.type === "identifier").pop()
    : undefined;
  return tail?.text ?? null;
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
      ...(jsonPropertyName(param)
        ? { jsonName: jsonPropertyName(param) }
        : {}),
      typeNode,
      required: hasRequiredAnnotation(param),
      ignored: hasJsonIgnore(param),
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
    const jsonName = jsonPropertyName(field);
    const ignored = hasJsonIgnore(field);
    for (const declarator of findAll(field, (n) => n.type === "variable_declarator")) {
      const nameNode = declarator.namedChildren.find((c) => c.type === "identifier");
      if (!nameNode) continue;
      fields.push({
        name: nameNode.text,
        ...(jsonName ? { jsonName } : {}),
        typeNode,
        required: hasRequiredAnnotation(field),
        ignored,
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
        typeParameters: collectTypeParameters(record),
        superclass: null,
        naming: classNamingStrategy(record),
      });
    }

    for (const cls of findAll(root, (n) => n.type === "class_declaration")) {
      const name = declarationName(cls);
      if (!name) continue;
      const discriminator = collectDiscriminator(cls);
      registerType({
        kind: "class",
        name,
        file: entry.path,
        node: cls,
        fields: collectClassFields(cls),
        enumValues: [],
        typeParameters: collectTypeParameters(cls),
        superclass: collectSuperclass(cls),
        naming: classNamingStrategy(cls),
        ...(discriminator ? { discriminator } : {}),
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
        typeParameters: [],
        superclass: null,
        naming: "default",
      });
    }
  }

  return { id: "java", files, types };
}

export { annotationName, modifiersOf, typeNodeOf, TYPE_NODE_TYPES };
