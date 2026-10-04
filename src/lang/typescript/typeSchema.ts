import type { JsonSchema } from "../../core/types.js";

/**
 * Minimal structural surface we need from the TypeScript compiler API.
 * The real module is an optional peer dependency loaded lazily; these types
 * are structural so this file compiles without `typescript` installed.
 */
export interface TsShim {
  SyntaxKind: Record<string, number>;
  ScriptKind: Record<string, number>;
  sys: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface SchemaContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ts: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  checker: any;
  /** Canonical component name -> schema. */
  components: Map<string, JsonSchema>;
  /** Symbol key -> component name, for reuse. */
  symbolToComponent: Map<string, string>;
  /** Files belonging to the scanned project (never node_modules / lib). */
  isProjectFile: (fileName: string) => boolean;
  /** Cycle guard, keyed by component name. */
  inProgress: Set<string>;
  /** Cycle guard for anonymous structural expansion, keyed by type id. */
  activeTypes: Set<string>;
}

let componentCounter = 0;

function uniqueName(base: string, taken: Set<string>): string {
  const clean = base.replace(/[^A-Za-z0-9_$]/g, "_") || "Schema";
  if (!taken.has(clean)) return clean;
  let suffix = 2;
  while (taken.has(`${clean}${suffix}`)) suffix += 1;
  return `${clean}${suffix}`;
}

function declarationInProject(ctx: SchemaContext, symbol: any): boolean {
  const declarations = symbol?.declarations ?? [];
  return declarations.some((d: any) => {
    const source = d.getSourceFile?.();
    return source && ctx.isProjectFile(source.fileName);
  });
}

function isNamedDeclarationKind(ts: TsShim, d: any): boolean {
  return [
    ts.SyntaxKind.InterfaceDeclaration,
    ts.SyntaxKind.ClassDeclaration,
    ts.SyntaxKind.TypeAliasDeclaration,
    ts.SyntaxKind.EnumDeclaration,
  ].includes(d.kind);
}

function isNamedUserDeclaration(ctx: SchemaContext, symbol: any): boolean {
  if (!symbol?.declarations || !declarationInProject(ctx, symbol)) return false;
  return symbol.declarations.some((d: any) =>
    isNamedDeclarationKind(ctx.ts, d),
  );
}

// Named declarations coming from node_modules are treated as opaque objects:
// structurally expanding them (e.g. a passthrough OpenAPI document) is both
// unbounded and uninformative, and can recurse forever.
function isExternalNamedDeclaration(ctx: SchemaContext, symbol: any): boolean {
  if (!symbol?.declarations) return false;
  const kinds = symbol.declarations.filter((d: any) =>
    isNamedDeclarationKind(ctx.ts, d),
  );
  if (!kinds.length) return false;
  return !kinds.some((d: any) => {
    const source = d.getSourceFile?.();
    return source && ctx.isProjectFile(source.fileName);
  });
}

function ref(name: string): JsonSchema {
  return { $ref: `#/components/schemas/${name}` };
}

function literalSchema(value: unknown): JsonSchema | undefined {
  if (typeof value === "string") return { type: "string", const: value };
  if (typeof value === "number")
    return { type: Number.isInteger(value) ? "integer" : "number", const: value };
  if (typeof value === "boolean") return { type: "boolean", const: value };
  return undefined;
}

/**
 * Converts a ts.Type to a JSON Schema. Named user declarations are hoisted
 * into components.schemas and referenced via $ref; anonymous types inline.
 */
export function typeToSchema(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type: any,
  ctx: SchemaContext,
  hintName?: string,
): JsonSchema {
  const { ts, checker } = ctx;

  // Unwrap Promise<T> and PromiseLike<T>.
  const promiseType = type.aliasSymbol?.name === "Promise" || type.symbol?.name === "Promise"
    ? type
    : undefined;
  if (promiseType) {
    const arg = checker.getTypeArguments?.(type)?.[0];
    if (arg) return typeToSchema(arg, ctx, hintName);
  }

  const flags = type.flags ?? 0;
  const flag = (name: string) =>
    Boolean(flags & (ts.TypeFlags[name] ?? 0));

  // Literals first (string/number/boolean literal flags).
  if (flag("StringLiteral")) {
    const value =
      typeof type.value === "string"
        ? type.value
        : checker.typeToString(type).replace(/^['"]|['"]$/g, "");
    return { type: "string", const: value };
  }
  if (flag("NumberLiteral")) {
    const value =
      typeof type.value === "number"
        ? type.value
        : Number(checker.typeToString(type).replace(/_/g, ""));
    return { type: Number.isInteger(value) ? "integer" : "number", const: value };
  }
  if (flag("BooleanLiteral"))
    return literalSchema(checker.typeToString(type) === "true") ?? { type: "boolean" };
  if (flag("String")) return { type: "string" };
  if (flag("Number")) return { type: "number" };
  if (flag("Boolean")) return { type: "boolean" };
  if (flag("BigInt")) return { type: "integer", format: "int64" };
  if (flag("Null")) return { type: "null" };
  if (flag("Undefined") || flag("Void")) return {};
  if (flag("Any") || flag("Unknown")) return {};
  if (flag("StringMapping")) return { type: "string" };

  // Enum-like unions of literals.
  if (flag("Union") || type.isUnion?.()) {
    return unionSchema(type, ctx, hintName);
  }

  const symbol = type.getSymbol?.() ?? type.aliasSymbol;
  const namePath = checker.typeToString
    ? checker.typeToString(type)
    : String(symbol?.name ?? hintName ?? "");

  // Well-known structural types.
  if (symbol?.name === "Date") return { type: "string", format: "date-time" };
  if (["Buffer", "Uint8Array", "ArrayBuffer", "Blob"].includes(symbol?.name))
    return { type: "string", format: "binary" };
  if (symbol?.name === "Map" || type.aliasSymbol?.name === "Record") {
    return recordSchema(type, ctx);
  }

  // Tuples.
  if (checker.isTupleType?.(type)) {
    const elements = checker.getTypeArguments?.(type) ?? [];
    const schemas = elements.map((t: any) => typeToSchema(t, ctx));
    const kinds = [...new Set(schemas.map((s: JsonSchema) => String(s.type ?? "object")))];
    return {
      type: "array",
      prefixItems: schemas,
      items:
        kinds.length === 1 ? { type: kinds[0] } : {},
      minItems: schemas.length,
    };
  }

  // Arrays.
  if (checker.isArrayType?.(type) || symbol?.name === "Array" || /\[\]$/.test(namePath)) {
    const numberIndex = checker.getIndexTypeOfType?.(type, ts.IndexKind.Number);
    const item = numberIndex ?? checker.getTypeArguments?.(type)?.[0];
    return { type: "array", items: item ? typeToSchema(item, ctx) : {} };
  }

  // Named user declaration -> hoist as component.
  if (symbol && isNamedUserDeclaration(ctx, symbol)) {
    return hoistComponent(type, symbol, ctx, hintName);
  }

  // External named declaration (library type): opaque and uninformative about
  // the user's contract; return an empty schema so the completeness gate keeps
  // an honest gap instead of treating it as a high-confidence user schema.
  if (symbol && isExternalNamedDeclaration(ctx, symbol)) {
    return {};
  }

  // Object shapes (including mapped Pick/Omit/Partial resolve here).
  const properties = type.getProperties?.() ?? [];
  const stringIndex = checker.getIndexTypeOfType?.(type, ts.IndexKind.String);
  if (properties.length > 0 || stringIndex) {
    // Cycle guard for anonymous recursive structural types.
    const typeKey = `t:${type.id ?? namePath}`;
    if (type.id != null && ctx.activeTypes.has(typeKey)) return {};
    ctx.activeTypes.add(typeKey);
    try {
      return objectSchema(type, properties, stringIndex, ctx, symbol);
    } finally {
      ctx.activeTypes.delete(typeKey);
    }
  }

  // Fallback: trust the apparent type once, otherwise leave open.
  const apparent = checker.getApparentType?.(type);
  if (apparent && apparent !== type) return typeToSchema(apparent, ctx, hintName);
  return {};
}

function unionSchema(type: any, ctx: SchemaContext, hintName?: string): JsonSchema {
  const members = (type.types ?? []).filter((t: any) => {
    const flags = t.flags ?? 0;
    return !(
      flags &
      (ctx.ts.TypeFlags.Undefined |
        ctx.ts.TypeFlags.Void |
        ctx.ts.TypeFlags.Never)
    );
  });

  const includesNull = members.some((t: any) =>
    Boolean(t.flags & ctx.ts.TypeFlags.Null),
  );
  const nonNull = members.filter((t: any) => !(t.flags & ctx.ts.TypeFlags.Null));

  // Drop members that resolve to empty schemas (opaque external library
  // types); an all-empty union carries no contract information.
  const memberSchemas = nonNull.map((t: any) => typeToSchema(t, ctx));
  const meaningful = memberSchemas.filter(
    (s: JsonSchema) => s && Object.keys(s).length > 0,
  );
  if (meaningful.length === 0) return {};
  if (!includesNull && meaningful.length === 1) return meaningful[0];

  // Single non-null member + null -> nullable scalar/object.
  if (includesNull && meaningful.length === 1) {
    const inner = meaningful[0];
    if (inner.$ref) return { oneOf: [inner, { type: "null" }] };
    const types = inner.type
      ? Array.isArray(inner.type)
        ? [...inner.type, "null"]
        : [inner.type, "null"]
      : undefined;
    return types ? { ...inner, type: types } : { oneOf: [inner, { type: "null" }] };
  }

  // Pure literal enum.
  const literals = nonNull.filter(
    (t: any) =>
      t.flags &
      (ctx.ts.TypeFlags.StringLiteral | ctx.ts.TypeFlags.NumberLiteral),
  );
  if (literals.length === nonNull.length && literals.length > 0) {
    const values = literals.map((t: any) => {
      const raw = ctx.checker.typeToString(t);
      if (t.flags & ctx.ts.TypeFlags.NumberLiteral) {
        return Number(raw.replace(/_/g, ""));
      }
      // typeToString quotes string literals; strip one matching pair.
      return raw.replace(/^(['"])(.*)\1$/, "$2");
    });
    const typeName = typeof values[0] === "number" ? "number" : "string";
    return { type: typeName, enum: values };
  }

  return {
    oneOf: [
      ...meaningful,
      ...(includesNull ? [{ type: "null" } as JsonSchema] : []),
    ],
  };
}

function recordSchema(type: any, ctx: SchemaContext): JsonSchema {
  const args = ctx.checker.getTypeArguments?.(type) ?? [];
  const valueType = args[1] ?? ctx.checker.getIndexTypeOfType?.(type, ctx.ts.IndexKind.String);
  return {
    type: "object",
    additionalProperties: valueType ? typeToSchema(valueType, ctx) : {},
  };
}

function objectSchema(
  type: any,
  properties: any[],
  stringIndex: any,
  ctx: SchemaContext,
  symbol: any,
): JsonSchema {
  const out: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const prop of properties) {
    if (prop.flags & ctx.ts.SymbolFlags.Method) continue;
    const declaration = prop.valueDeclaration ?? prop.declarations?.[0];
    let propType: any;
    try {
      propType = declaration
        ? ctx.checker.getTypeOfSymbolAtLocation(prop, declaration)
        : undefined;
    } catch {
      propType = undefined;
    }
    if (!propType) continue;
    const includesUndefined = Boolean(
      propType.flags & ctx.ts.TypeFlags.Undefined ||
        propType.isUnion?.() &&
          propType.types?.some((t: any) => t.flags & ctx.ts.TypeFlags.Undefined),
    );
    // A project with strictNullChecks:false erases explicit null/undefined
    // unions from checker types. Preserve the written wire contract.
    const writtenTypes = declaration?.type && ctx.ts.isUnionTypeNode(declaration.type) ? declaration.type.types : [];
    const writtenUndefined = writtenTypes.some((node:any) => node.kind === ctx.ts.SyntaxKind.UndefinedKeyword);
    const writtenNull = writtenTypes.some((node:any) => ctx.ts.isLiteralTypeNode(node) && node.literal.kind === ctx.ts.SyntaxKind.NullKeyword);
    const optional = Boolean(declaration?.questionToken) || includesUndefined || writtenUndefined;
    if (!optional) required.push(prop.name);
    let schema = typeToSchema(propType, ctx, prop.name);
    if (writtenNull && Object.keys(schema).length && schema.type !== "null" &&
        !(Array.isArray(schema.type) && schema.type.includes("null")) &&
        !(Array.isArray(schema.anyOf) && schema.anyOf.some(s => s.type === "null"))) {
      if (typeof schema.type === "string" && !schema.enum && !("const" in schema)) schema = {...schema, type: [schema.type, "null"]};
      else schema = {anyOf: [schema, {type: "null"}]};
    }
    out[prop.name] = schema;
  }

  const schema: JsonSchema = {
    type: "object",
    ...(Object.keys(out).length ? { properties: out } : {}),
    ...(required.length ? { required } : {}),
  };
  if (stringIndex) {
    schema.additionalProperties = typeToSchema(stringIndex, ctx);
  }
  if (symbol?.name === "Partial" || type.aliasSymbol?.name === "Partial") {
    delete schema.required;
  }
  return schema;
}

/**
 * Stable short name for a generic type argument, mirroring the Java typeKey
 * conventions: named types keep their symbol name, arrays gain a List suffix.
 */
function genericArgShortName(type: any, ctx: SchemaContext): string {
  const { ts, checker } = ctx;
  const flags = type.flags ?? 0;
  const flag = (name: string) => Boolean(flags & (ts.TypeFlags[name] ?? 0));
  if (flag("String") || flag("StringLiteral")) return "String";
  if (flag("Number") || flag("NumberLiteral")) return "Number";
  if (flag("Boolean") || flag("BooleanLiteral")) return "Boolean";
  const numberIndex = checker.getIndexTypeOfType?.(type, ts.IndexKind.Number);
  const typeArgs = checker.getTypeArguments?.(type) ?? [];
  if (checker.isArrayType?.(type) || type.symbol?.name === "Array" || numberIndex) {
    const item = numberIndex ?? typeArgs[0];
    return `${genericArgShortName(item ?? type, ctx)}List`;
  }
  const symbol = type.getSymbol?.() ?? type.aliasSymbol;
  if (symbol?.name) {
    const nestedArgs: any[] = checker.getTypeArguments?.(type) ?? [];
    const decl = symbol.declarations?.find((d: any) => d.typeParameters?.length);
    const params: any[] = decl?.typeParameters ?? [];
    const instantiated =
      nestedArgs.length === params.length &&
      nestedArgs.length > 0 &&
      nestedArgs.some((arg, i) => arg !== params[i]);
    return instantiated
      ? `${symbol.name}_${nestedArgs.map((arg) => genericArgShortName(arg, ctx)).join("_")}`
      : symbol.name;
  }
  const printed = checker.typeToString ? checker.typeToString(type) : "T";
  return printed.replace(/[^A-Za-z0-9_]/g, "_");
}

function hoistComponent(
  type: any,
  symbol: any,
  ctx: SchemaContext,
  hintName?: string,
): JsonSchema {
  const { checker } = ctx;

  // Generic instantiations (ApiResponse<Product>, PageResult<T[]>) get their
  // own specialized component; the checker already binds property types to
  // the concrete arguments, so two instantiations must not share one schema.
  const typeArgs: any[] = checker.getTypeArguments?.(type) ?? [];
  const declaration = symbol.declarations?.find((d: any) => d.typeParameters?.length);
  const typeParameters: any[] = declaration?.typeParameters ?? [];
  const instantiated =
    typeArgs.length > 0 &&
    typeArgs.length === typeParameters.length &&
    typeArgs.some((arg, i) => arg !== typeParameters[i]);
  const argKey = instantiated
    ? `⟨${typeArgs.map((arg) => arg.id ?? checker.typeToString?.(arg)).join(",")}⟩`
    : "";
  const key = `${String(symbol.id ?? symbol.name)}${argKey}`;
  const existing = ctx.symbolToComponent.get(key);
  if (existing) return ref(existing);

  const baseName = symbol.name ?? hintName;
  const suffix = instantiated
    ? `_${typeArgs.map((arg) => genericArgShortName(arg, ctx)).join("_")}`
    : "";
  const name = uniqueName(`${baseName}${suffix}`, new Set(ctx.components.keys()));
  ctx.symbolToComponent.set(key, name);
  ctx.inProgress.add(name);

  // Enums.
  if (symbol.declarations?.some((d: any) => d.kind === ctx.ts.SyntaxKind.EnumDeclaration)) {
    const literals = (type.types ?? []).map((t: any) =>
      ctx.checker.typeToString(t),
    );
    const numeric = literals.every((v: string) => /^-?\d+$/.test(v));
    ctx.components.set(name, {
      type: numeric ? "number" : "string",
      ...(literals.length ? { enum: numeric ? literals.map(Number) : literals } : {}),
    });
  } else {
    const properties = type.getProperties?.() ?? [];
    const stringIndex = ctx.checker.getIndexTypeOfType?.(
      type,
      ctx.ts.IndexKind.String,
    );
    // Build the schema before registering the component so a failure never
    // leaves a dangling $ref; fall back to an opaque object rather than throw.
    let schema: JsonSchema;
    try {
      schema = objectSchema(type, properties, stringIndex, ctx, symbol);
    } catch {
      schema = { type: "object" };
    }
    ctx.components.set(name, schema);
  }

  ctx.inProgress.delete(name);
  componentCounter += 1;
  return ref(name);
}

/** Creates the shared schema conversion context for one scan. */
export function createSchemaContext(
  ts: TsShim,
  checker: any,
  isProjectFile: (fileName: string) => boolean,
): SchemaContext {
  return {
    ts,
    checker,
    components: new Map(),
    symbolToComponent: new Map(),
    isProjectFile,
    inProgress: new Set(),
    activeTypes: new Set(),
  };
}

/** Clones a component map for per-handler isolation. */
export function forkComponentCollector(ctx: SchemaContext): Map<string, JsonSchema> {
  return new Map(ctx.components);
}
