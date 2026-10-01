/**
 * Converts Python type annotations and Pydantic models into JSON Schema.
 * Only evidence present in the source is emitted; unknown shapes return null
 * so the framework pack can record a gap instead of inventing a schema.
 */

import type {
  Confidence,
  DiscoveredComponent,
  JsonSchema,
} from "../../core/types.js";
import type { PyClass, PythonAnalysis, PyField } from "./index.js";
import type { TsNode } from "../treesitter/runtime.js";
import { childrenOfType, firstChildOfType, literalString } from "../treesitter/ast.js";

const SCALAR_MAP: Record<string, JsonSchema> = {
  int: { type: "integer" },
  float: { type: "number" },
  complex: { type: "number" },
  str: { type: "string" },
  bytes: { type: "string", format: "binary" },
  bool: { type: "boolean" },
  boolean: { type: "boolean" },
  Any: {},
  object: { type: "object" },
  dict: { type: "object" },
  Dict: { type: "object" },
  list: { type: "array", items: {} },
  List: { type: "array", items: {} },
  Sequence: { type: "array", items: {} },
  Iterable: { type: "array", items: {} },
  set: { type: "array", items: {} },
  Set: { type: "array", items: {} },
  tuple: { type: "array", items: {} },
  Tuple: { type: "array", items: {} },
  UUID: { type: "string", format: "uuid" },
  uuid: { type: "string", format: "uuid" },
  datetime: { type: "string", format: "date-time" },
  date: { type: "string", format: "date" },
  time: { type: "string", format: "time" },
  timedelta: { type: "string", format: "duration" },
  Decimal: { type: "number" },
  HttpUrl: { type: "string", format: "uri" },
  AnyHttpUrl: { type: "string", format: "uri" },
  EmailStr: { type: "string", format: "email" },
  None: { type: "null" },
};

export interface ModelIndex {
  analysis: PythonAnalysis;
  pydanticNames: Set<string>;
  enumNames: Set<string>;
  componentsByName: Map<string, DiscoveredComponent>;
}

function baseName(node: TsNode): string {
  const parts = node.text.trim().split(/\s+/);
  return parts[parts.length - 1] ?? node.text.trim();
}

/** Fixpoint classification of Pydantic models and enum classes. */
export function buildModelIndex(analysis: PythonAnalysis): ModelIndex {
  const pydanticNames = new Set<string>();
  const enumNames = new Set<string>();

  const isPydanticBase = (node: TsNode): boolean => {
    const text = node.text.trim();
    if (analysis.pydanticBaseNames.has(text)) return true;
    if (text === "pydantic.BaseModel" || text.endsWith(".BaseModel")) return true;
    const tail = text.split(".").pop() ?? text;
    if (analysis.pydanticBaseNames.has(tail)) return true;
    return false;
  };
  const isEnumBase = (node: TsNode): boolean => {
    const text = node.text.trim();
    if (analysis.enumBaseNames.has(text)) return true;
    if (text.startsWith("enum.") || /\.(Enum|StrEnum|IntEnum|Flag)$/.test(text)) {
      return true;
    }
    const tail = text.split(".").pop() ?? text;
    return analysis.enumBaseNames.has(tail);
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const cls of analysis.classes) {
      if (pydanticNames.has(cls.name) || enumNames.has(cls.name)) continue;
      if (cls.bases.some((base) => isEnumBase(base) || enumNames.has(baseName(base)))) {
        enumNames.add(cls.name);
        changed = true;
        continue;
      }
      if (
        cls.bases.some(
          (base) => isPydanticBase(base) || pydanticNames.has(baseName(base)),
        )
      ) {
        pydanticNames.add(cls.name);
        changed = true;
      }
    }
  }

  return {
    analysis,
    pydanticNames,
    enumNames,
    componentsByName: new Map(),
  };
}

function literalValue(node: TsNode): unknown {
  const s = literalString(node);
  if (s !== null) return s;
  if (node.type === "integer") return Number.parseInt(node.text, 10);
  if (node.type === "float") return Number.parseFloat(node.text);
  if (node.type === "true") return true;
  if (node.type === "false") return false;
  if (node.type === "none") return null;
  return undefined;
}

function genericParts(node: TsNode): { name: string; args: TsNode[] } | null {
  // Current grammars expose generic_type; older ones use subscript.
  let nameNode: TsNode | null = null;
  let args: TsNode[] = [];
  if (node.type === "generic_type") {
    nameNode = node.namedChildren[0] ?? null;
    const params = childrenOfType(node, "type_parameter");
    // A single type_parameter holds comma-separated `type` wrapper children.
    args = params.flatMap((parameter) =>
      parameter.namedChildren.map((child) =>
        child.type === "type" ? child.namedChildren[0] ?? child : child,
      ),
    );
  } else if (node.type === "subscript") {
    nameNode = node.namedChildren[0] ?? null;
    const slice = childrenOfType(node, "subscript")[0] ?? node.namedChildren[1];
    if (slice) {
      args =
        slice.type === "tuple"
          ? slice.namedChildren
          : slice.type === "type_parameter"
            ? slice.namedChildren
            : [slice];
    }
  }
  if (!nameNode) return null;
  return { name: nameNode.text, args };
}

function isNoneNode(node: TsNode | null | undefined): boolean {
  return !!node && node.type === "none";
}

export function annotationToSchema(
  node: TsNode | null,
  index: ModelIndex,
  depth = 0,
): JsonSchema | null {
  if (!node || depth > 6) return null;

  // X | Y unions (PEP 604).
  if (node.type === "binary_operator" && node.text.includes("|")) {
    const variants = node.namedChildren.filter((child) => child.type !== "none");
    const nullable = node.namedChildren.some(isNoneNode);
    const schemas = variants
      .map((variant) => annotationToSchema(variant, index, depth + 1))
      .filter((schema): schema is JsonSchema => schema !== null);
    if (!schemas.length) return nullable ? { type: "null" } : null;
    if (schemas.length === 1) {
      return nullable ? { ...schemas[0], nullable: true } : schemas[0];
    }
    const union: JsonSchema = { anyOf: schemas };
    return nullable ? { ...union, nullable: true } : union;
  }

  if (node.type === "generic_type" || node.type === "subscript") {
    const generic = genericParts(node);
    if (!generic) return null;
    const name = generic.name.split(".").pop() ?? generic.name;

    if (name === "Annotated" && generic.args[0]) {
      return annotationToSchema(generic.args[0], index, depth + 1);
    }
    if (name === "Literal" || name === "typing.Literal") {
      const values = generic.args.map(literalValue).filter((v) => v !== undefined);
      if (!values.length) return null;
      const type = typeof values[0];
      return {
        ...(type === "number"
          ? { type: Number.isInteger(values[0]) ? "integer" : "number" }
          : type === "boolean"
            ? { type: "boolean" }
            : { type: "string" }),
        enum: values as (string | number | boolean)[],
      };
    }
    if (name === "Optional" && generic.args[0]) {
      const inner = annotationToSchema(generic.args[0], index, depth + 1);
      return inner ? { ...inner, nullable: true } : null;
    }
    if (name === "Union") {
      const variants = generic.args.filter((arg) => !isNoneNode(arg));
      const nullable = generic.args.some(isNoneNode);
      const schemas = variants
        .map((arg) => annotationToSchema(arg, index, depth + 1))
        .filter((schema): schema is JsonSchema => schema !== null);
      if (schemas.length === 1) return nullable ? { ...schemas[0], nullable: true } : schemas[0];
      if (schemas.length > 1) {
        const union: JsonSchema = { anyOf: schemas };
        return nullable ? { ...union, nullable: true } : union;
      }
      return null;
    }
    if (["list", "List", "Sequence", "Iterable", "set", "Set", "tuple", "Tuple"].includes(name)) {
      const items = generic.args[0]
        ? annotationToSchema(generic.args[0], index, depth + 1)
        : {};
      return { type: "array", items: items ?? {} };
    }
    if (["dict", "Dict", "Mapping"].includes(name)) {
      const schema: JsonSchema = { type: "object" };
      const valueType = generic.args[1]
        ? annotationToSchema(generic.args[1], index, depth + 1)
        : null;
      if (valueType) schema.additionalProperties = valueType;
      return schema;
    }
    if (SCALAR_MAP[generic.name] || SCALAR_MAP[name]) {
      return SCALAR_MAP[name] ?? SCALAR_MAP[generic.name] ?? null;
    }
    // Parameterized model (e.g. generic Pydantic classes): ref the base name.
    if (index.pydanticNames.has(generic.name)) {
      ensureComponent(generic.name, index);
      return { $ref: `#/components/schemas/${generic.name}` };
    }
    return null;
  }

  if (node.type === "identifier" || node.type === "attribute") {
    const name = node.type === "attribute" ? (node.namedChildren[1]?.text ?? node.text) : node.text;
    if (index.pydanticNames.has(name)) {
      ensureComponent(name, index);
      return { $ref: `#/components/schemas/${name}` };
    }
    if (index.enumNames.has(name)) {
      ensureComponent(name, index);
      return { $ref: `#/components/schemas/${name}` };
    }
    return SCALAR_MAP[name] ?? null;
  }

  if (node.type === "string") {
    // Forward-reference annotation such as "Item".
    const s = literalString(node);
    if (s && (index.pydanticNames.has(s) || index.enumNames.has(s))) {
      ensureComponent(s, index);
      return { $ref: `#/components/schemas/${s}` };
    }
    return { type: "string" };
  }

  return null;
}

function enumValues(cls: PyClass): { type: string; values: (string | number)[] } | null {
  const values: (string | number)[] = [];
  let type: "string" | "integer" | null = null;
  for (const statement of childrenOfType(cls.node, "block").flatMap((block) =>
    childrenOfType(block, "expression_statement"),
  )) {
    const assignment = firstChildOfType(statement, "assignment");
    if (!assignment) continue;
    const value = assignment.namedChildren[1];
    const literal = value ? literalValue(value) : undefined;
    if (typeof literal === "string") {
      type ??= "string";
      values.push(literal);
    } else if (typeof literal === "number") {
      type ??= Number.isInteger(literal) ? "integer" : null;
      values.push(literal);
    }
  }
  if (!type || !values.length) return null;
  return { type, values };
}

export function fieldRequired(field: PyField, index: ModelIndex): boolean {
  if (!field.annotation) return field.default === null;
  // Optional / X | None annotations are never required.
  if (field.annotation.type === "binary_operator" && field.annotation.text.includes("None")) {
    return false;
  }
  const generic = field.annotation.type === "generic_type" ? genericParts(field.annotation) : null;
  if (generic?.name.split(".").pop() === "Optional") return false;
  if (!field.default) return true;
  // Ellipsis default (`Field(...)` or bare `...`) means required.
  if (field.default.type === "ellipsis") return true;
  return false;
}

export function buildComponent(
  cls: PyClass,
  index: ModelIndex,
  stack: Set<string> = new Set(),
): DiscoveredComponent | null {
  if (index.enumNames.has(cls.name)) {
    const enumeration = enumValues(cls);
    if (!enumeration) return null;
    return { name: cls.name, schema: { type: enumeration.type, enum: enumeration.values } };
  }

  if (stack.has(cls.name)) return { name: cls.name, schema: {} };
  stack.add(cls.name);

  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  // Inherit fields from model superclasses first.
  for (const base of cls.bases) {
    const parentName = baseName(base);
    if (!index.pydanticNames.has(parentName) || parentName === cls.name) continue;
    const parent = index.analysis.classes.find((candidate) => candidate.name === parentName);
    if (!parent) continue;
    const parentComponent = buildComponent(parent, index, new Set(stack));
    const parentSchema = parentComponent?.schema;
    if (parentSchema?.properties) {
      for (const [key, value] of Object.entries(parentSchema.properties)) {
        properties[key] = value as JsonSchema;
      }
      for (const key of (parentSchema.required as string[]) ?? []) required.push(key);
    }
  }

  for (const field of cls.fields) {
    const schema = field.annotation
      ? annotationToSchema(field.annotation, index, 1)
      : null;
    if (schema) properties[field.name] = schema;
    if (fieldRequired(field, index) && schema) required.push(field.name);
  }

  stack.delete(cls.name);

  const schema: JsonSchema = {
    type: "object",
    properties,
    ...(required.length ? { required: [...new Set(required)] } : {}),
  };
  return { name: cls.name, schema };
}

export function ensureComponent(name: string, index: ModelIndex): void {
  if (index.componentsByName.has(name)) return;
  const cls = index.analysis.classes.find((candidate) => candidate.name === name);
  if (!cls) return;
  // Reserve the slot first to break recursive models.
  index.componentsByName.set(name, { name, schema: {} });
  const component = buildComponent(cls, index);
  if (component) index.componentsByName.set(name, component);
}

/**
 * True when a literal-derived schema carries no usable shape (empty object,
 * empty array items, or properties whose values are unconstrained).
 */
export function isLooseLiteralSchema(schema: JsonSchema): boolean {
  if (schema.type === "array") {
    const items = schema.items as JsonSchema | undefined;
    return !items || Object.keys(items).length === 0;
  }
  if (schema.type === "object") {
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    if (Object.keys(properties).length === 0) return true;
    return Object.values(properties).some((property) => Object.keys(property).length === 0);
  }
  return false;
}

export function confidenceForSchema(schema: JsonSchema | null): Confidence {
  return schema ? "high" : "medium";
}

/**
 * Converts a literal value (dict/list/scalar returned from a handler) into a
 * loose JSON Schema. Nested non-literal shapes degrade to an empty schema
 * rather than being invented.
 */
export function literalToSchema(node: TsNode | null, depth = 0): JsonSchema | null {
  if (!node || depth > 6) return {};
  if (node.type === "dictionary") {
    const properties: Record<string, JsonSchema> = {};
    for (const pair of childrenOfType(node, "pair")) {
      const [key, value] = pair.namedChildren;
      const keyText = key ? literalString(key) : null;
      if (!keyText || !value) continue;
      const schema = literalToSchema(value, depth + 1);
      if (schema) properties[keyText] = schema;
    }
    return { type: "object", properties };
  }
  if (node.type === "list" || node.type === "tuple" || node.type === "set") {
    const first = node.namedChildren[0];
    return { type: "array", items: first ? literalToSchema(first, depth + 1) ?? {} : {} };
  }
  if (node.type === "string" || node.type === "string_start") return { type: "string" };
  if (node.type === "integer") return { type: "integer" };
  if (node.type === "float") return { type: "number" };
  if (node.type === "true" || node.type === "false") return { type: "boolean" };
  if (node.type === "none") return { type: "null" };
  // jsonify(model) / variable references carry no literal shape.
  return {};
}
