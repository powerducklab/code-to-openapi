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
  /** Bean Validation constraints that map precisely to JSON Schema keywords. */
  readonly validation?: JavaFieldValidation;
}

/**
 * Bean Validation constraints we can map to JSON Schema without guessing.
 * Only annotations whose value maps 1:1 to a schema keyword are captured.
 */
export interface JavaFieldValidation {
  readonly readOnly?: boolean;
  readonly writeOnly?: boolean;
  /** `@Email` -> `format: "email"`. */
  readonly format?: "email";
  /** `@Size(min = N)` / `@Length(min = N)` -> `minLength`. */
  readonly minLength?: number;
  /** `@Size(max = N)` / `@Length(max = N)` -> `maxLength`. */
  readonly maxLength?: number;
  /** `@Min(N)` -> `minimum`. */
  readonly minimum?: number;
  /** `@Max(N)` -> `maximum`. */
  readonly maximum?: number;
  /** `@Pattern(regexp = "...")` -> `pattern`. */
  readonly pattern?: string;
}

export interface JavaTypeDef {
  readonly kind: "record" | "class" | "enum";
  readonly name: string;
  /** Fully qualified name including enclosing classes, e.g. a.b.Outer.Inner. */
  readonly fqn: string;
  readonly packageName: string;
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
  /** Keyed by fully qualified name, e.g. cn.apipost.result.CommonResult. */
  readonly typesByFqn: Map<string, JavaTypeDef>;
  /** Per-file import table used for simple-name resolution. */
  readonly imports: Map<
    string,
    {
      readonly packageName: string;
      readonly explicit: Map<string, string>;
      readonly wildcards: string[];
    }
  >;
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
  "scoped_type_identifier",
  "wildcard",
]);

function modifiersOf(node: TsNode): TsNode[] {
  const mods = node.namedChildren.find((child) => child.type === "modifiers");
  return mods ? mods.namedChildren : [];
}

function hasRequiredAnnotation(node: TsNode): boolean {
  return modifiersOf(node).some((mod) => {
    if (mod.type !== "annotation" && mod.type !== "marker_annotation") return false;
    const name = mod.namedChildren.find((c) => c.type === "identifier");
    return name ? REQUIRED_ANNOTATIONS.has(name.text) || (name.text === "Schema" &&
      (/^(?:Schema\.RequiredMode\.)?REQUIRED$/.test(annotationPairValue(mod, "requiredMode")?.text ?? "") || annotationPairValue(mod, "required")?.text === "true")) : false;
  });
}

/** Reads a named `key = value` pair out of an annotation argument list. */
function annotationPairValue(
  annotation: TsNode,
  key: string,
): TsNode | undefined {
  const args = childrenOfType(annotation, "annotation_argument_list")[0];
  if (!args) return undefined;
  for (const pair of childrenOfType(args, "element_value_pair")) {
    const k = pair.namedChildren.find((c) => c.type === "identifier");
    if (k && k.text === key) {
      return pair.namedChildren[pair.namedChildren.length - 1];
    }
  }
  return undefined;
}

/** Reads a single positional annotation argument, e.g. `@Min(5)`. */
function annotationPositionalValue(annotation: TsNode): TsNode | undefined {
  const args = childrenOfType(annotation, "annotation_argument_list")[0];
  if (!args) return undefined;
  return args.namedChildren.find(
    (c) => c.type !== "element_value_pair",
  );
}

function numericText(node: TsNode | undefined): number | undefined {
  if (!node) return undefined;
  const n = Number(node.text.replace(/(?<=\d)[lL]$/, ""));
  return Number.isFinite(n) ? n : undefined;
}

function stringLiteralText(node: TsNode | undefined): string | undefined {
  if (!node) return undefined;
  try { return JSON.parse(node.text); } catch { return undefined; }
}

/**
 * Extracts Bean Validation constraints that map precisely to JSON Schema.
 * Anything that cannot be mapped 1:1 (custom constraints, groups, messages)
 * is intentionally ignored rather than guessed.
 */
export function extractValidation(node: TsNode): JavaFieldValidation | undefined {
  let result: JavaFieldValidation | undefined;
  const set = (patch: Partial<JavaFieldValidation>) => {
    result = { ...(result ?? {}), ...patch };
  };
  for (const mod of modifiersOf(node)) {
    if (mod.type !== "annotation" && mod.type !== "marker_annotation") continue;
    const name = mod.namedChildren.find((c) => c.type === "identifier")?.text;
    if (!name) continue;
    if (name === "Schema" || name === "JsonProperty") {
      const access = annotationPairValue(mod, name === "Schema" ? "accessMode" : "access")?.text;
      if (access?.endsWith(".READ_ONLY")) set({ readOnly: true });
      if (access?.endsWith(".WRITE_ONLY")) set({ writeOnly: true });
    } else if (name === "Email") {
      set({ format: "email" });
    } else if (name === "Size" || name === "Length") {
      const min = numericText(annotationPairValue(mod, "min"));
      const max = numericText(annotationPairValue(mod, "max"));
      if (min !== undefined) set({ minLength: min });
      if (max !== undefined) set({ maxLength: max });
    } else if (name === "Min") {
      const value = numericText(annotationPositionalValue(mod) ?? annotationPairValue(mod, "value"));
      if (value !== undefined) set({ minimum: value });
    } else if (name === "Max") {
      const value = numericText(annotationPositionalValue(mod) ?? annotationPairValue(mod, "value"));
      if (value !== undefined) set({ maximum: value });
    } else if (name === "Pattern") {
      const regex = stringLiteralText(annotationPairValue(mod, "regexp"));
      if (regex) set({ pattern: regex });
    }
  }
  return result;
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
        c.type === "scoped_identifier" ||
        c.type === "scoped_type_identifier",
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
    const fieldValidation = extractValidation(param);
    fields.push({
      name: nameNode.text,
      ...(jsonPropertyName(param)
        ? { jsonName: jsonPropertyName(param) }
        : {}),
      typeNode,
      required: hasRequiredAnnotation(param),
      ignored: hasJsonIgnore(param),
      ...(fieldValidation ? { validation: fieldValidation } : {}),
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
    if (mods && mods.children.some(c => c.text === "static")) continue;
    const typeNode = typeNodeOf(field);
    if (!typeNode) continue;
    const jsonName = jsonPropertyName(field);
    const ignored = hasJsonIgnore(field);
    for (const declarator of findAll(field, (n) => n.type === "variable_declarator")) {
      const nameNode = declarator.namedChildren.find((c) => c.type === "identifier");
      if (!nameNode) continue;
      const fieldValidation = extractValidation(field);
      fields.push({
        name: nameNode.text,
        ...(jsonName ? { jsonName } : {}),
        typeNode,
        required: hasRequiredAnnotation(field),
        ignored,
        ...(fieldValidation ? { validation: fieldValidation } : {}),
      });
    }
  }
  // Immutable DTOs and interface-backed models often expose properties only
  // through getters. Derive the missing ones following JavaBeans rules.
  const declared = new Set(fields.map((field) => field.name));
  for (const getter of collectGetterFields(body)) {
    if (declared.has(getter.name)) {
      const position = fields.findIndex(field => field.name === getter.name);
      const field = fields[position]!;
      fields[position] = { ...field,
        required: field.required || getter.required,
        ignored: field.ignored || getter.ignored,
        ...(getter.jsonName ? { jsonName: getter.jsonName } : {}),
        ...((field.validation || getter.validation) ? { validation: { ...field.validation, ...getter.validation } } : {}),
      };
      continue;
    }
    declared.add(getter.name);
    fields.push(getter);
  }
  return fields;
}

/** JavaBeans Introspector.decapitalize semantics. */
function decapitalizeBean(name: string): string {
  if (name.length > 1 && name === name.toUpperCase()) return name;
  return name.charAt(0).toLowerCase() + name.slice(1);
}

function collectGetterFields(body: TsNode): JavaField[] {
  const fields: JavaField[] = [];
  // Direct members only. A recursive walk would pull getters declared on nested
  // (e.g. static inner) DTO classes into the enclosing type and leak their
  // properties (such as BookInfo.title onto AuthorDTO).
  for (const method of childrenOfType(body, "method_declaration")) {
    const mods = method.namedChildren.find((c) => c.type === "modifiers");
    if (mods && mods.children.some(c => c.text === "static")) continue;
    const params = findFirst(method, (n) => n.type === "formal_parameters");
    if (params && childrenOfType(params, "formal_parameter").length > 0) continue;
    const nameNode = method.namedChildren.find((c) => c.type === "identifier");
    if (!nameNode) continue;
    const name = nameNode.text;
    let property: string | null = null;
    if (/^get[A-Z]/.test(name) && name !== "getClass") {
      property = decapitalizeBean(name.slice(3));
    } else if (/^is[A-Z]/.test(name)) {
      property = decapitalizeBean(name.slice(2));
    }
    if (!property) continue;
    const typeNode = typeNodeOf(method);
    if (!typeNode || typeNode.type === "void_type") continue;
    const getterValidation = extractValidation(method);
    fields.push({
      name: property,
      ...(jsonPropertyName(method) ? { jsonName: jsonPropertyName(method) } : {}),
      typeNode,
      required: hasRequiredAnnotation(method),
      ignored: hasJsonIgnore(method),
      ...(getterValidation ? { validation: getterValidation } : {}),
    });
  }
  return fields;
}

function collectInterfaceFields(node: TsNode): JavaField[] {
  const body = childrenOfType(node, "interface_body")[0];
  return body ? collectGetterFields(body) : [];
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

const TYPE_BODY_NODES = new Set([
  "class_body",
  "record_body",
  "enum_body",
  "interface_body",
]);

/** Enclosing simple names for a nested type, outermost first. */
function enclosingTypeNames(node: TsNode): string[] {
  const names: string[] = [];
  let current = node.parent;
  while (current) {
    if (TYPE_BODY_NODES.has(current.type)) {
      const owner = current.parent;
      if (
        owner &&
        /_declaration$/.test(owner.type) &&
        owner.type !== "annotation_type_declaration"
      ) {
        const ownerName = declarationName(owner);
        if (ownerName) names.unshift(ownerName);
      }
    }
    current = current.parent;
  }
  return names;
}

function collectImports(root: TsNode): { explicit: Map<string, string>; wildcards: string[] } {
  const explicit = new Map<string, string>();
  const wildcards: string[] = [];
  for (const imp of findAll(root, (n) => n.type === "import_declaration")) {
    const scoped = findFirst(imp, (n) => n.type === "scoped_identifier");
    if (!scoped) continue;
    const isWildcard = imp.namedChildren.some((c) => c.type === "asterisk");
    if (isWildcard) {
      wildcards.push(scoped.text);
    } else {
      const simple = scoped.text.slice(scoped.text.lastIndexOf(".") + 1);
      explicit.set(simple, scoped.text);
    }
  }
  return { explicit, wildcards };
}

export async function createJavaAnalysis(
  ctx: ScanContext,
): Promise<JavaAnalysis | null> {
  const javaFiles = ctx.index.files.filter((file) => /\.java$/.test(file.path));
  if (javaFiles.length === 0) return null;

  const files = new Map<string, JavaFile>();
  const types = new Map<string, JavaTypeDef>();
  const typesByFqn = new Map<string, JavaTypeDef>();
  const imports = new Map<
    string,
    { packageName: string; explicit: Map<string, string>; wildcards: string[] }
  >();

  const registerType = (def: JavaTypeDef) => {
    if (!types.has(def.name)) types.set(def.name, def);
    if (!typesByFqn.has(def.fqn)) typesByFqn.set(def.fqn, def);
  };

  const buildDef = (
    kind: JavaTypeDef["kind"],
    node: TsNode,
    entry: { path: string },
    packageName: string,
  ): JavaTypeDef | null => {
    const name = declarationName(node);
    if (!name) return null;
    const enclosing = enclosingTypeNames(node);
    const fqn = packageName
      ? `${packageName}.${[...enclosing, name].join(".")}`
      : [...enclosing, name].join(".");
    const discriminator = kind === "class" ? collectDiscriminator(node) : null;
    return {
      kind,
      name,
      fqn,
      packageName,
      file: entry.path,
      node,
      fields:
        kind === "record"
          ? collectRecordParams(node)
          : kind === "enum"
            ? []
            : node.type === "interface_declaration"
              ? collectInterfaceFields(node)
              : collectClassFields(node),
      enumValues: kind === "enum" ? collectEnumValues(node) : [],
      typeParameters: collectTypeParameters(node),
      superclass: collectSuperclass(node),
      naming: classNamingStrategy(node),
      ...(discriminator ? { discriminator } : {}),
    };
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

    const table = collectImports(root);
    imports.set(entry.path, {
      packageName,
      explicit: table.explicit,
      wildcards: table.wildcards,
    });

    for (const record of findAll(root, (n) => n.type === "record_declaration")) {
      const def = buildDef("record", record, entry, packageName);
      if (def) registerType(def);
    }
    for (const cls of findAll(root, (n) => n.type === "class_declaration")) {
      const def = buildDef("class", cls, entry, packageName);
      if (def) registerType(def);
    }
    for (const iface of findAll(root, (n) => n.type === "interface_declaration")) {
      const def = buildDef("class", iface, entry, packageName);
      if (def) registerType(def);
    }
    for (const en of findAll(root, (n) => n.type === "enum_declaration")) {
      const def = buildDef("enum", en, entry, packageName);
      if (def) registerType(def);
    }
  }

  return { id: "java", files, types, typesByFqn, imports };
}

export { annotationName, modifiersOf, typeNodeOf, TYPE_NODE_TYPES };
