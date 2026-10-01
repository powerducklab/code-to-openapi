/**
 * Python language pack.
 *
 * Produces a language-specific analysis (parsed trees, class/function index
 * and import bindings) consumed by Python framework packs. TypeScript is used
 * for static typing; Python projects are parsed with tree-sitter only, so no
 * Python toolchain is required on the scanning machine.
 */

import type { ScanContext } from "../../core/types.js";
import { parseSource, type TsNode } from "../treesitter/runtime.js";
import { childrenOfType, findAll, firstChildOfType, unwrapType } from "../treesitter/ast.js";

export interface PyParam {
  name: string;
  annotation: TsNode | null;
  default: TsNode | null;
  kind: "plain" | "vararg" | "kwarg";
}

export interface PyFunction {
  name: string;
  file: string;
  /** function_definition node (the decorated_definition carries decorators). */
  node: TsNode;
  decorated: TsNode | null;
  decorators: TsNode[];
  params: PyParam[];
  returnType: TsNode | null;
  body: TsNode | null;
}

export interface PyField {
  name: string;
  annotation: TsNode | null;
  default: TsNode | null;
}

export interface PyClass {
  name: string;
  file: string;
  node: TsNode;
  /** Raw base expression nodes. */
  bases: TsNode[];
  fields: PyField[];
}

export interface PyImportedName {
  module: string;
  importedName: string | null;
}

export interface PyFile {
  path: string;
  content: string;
  root: TsNode;
  /** Local binding name -> import descriptor. */
  imports: Map<string, PyImportedName>;
}

export interface PythonAnalysis {
  id: "python";
  files: Map<string, PyFile>;
  classes: PyClass[];
  functions: PyFunction[];
  /** Binding names that resolve to pydantic.BaseModel (any v1/v2 import style). */
  pydanticBaseNames: Set<string>;
  /** Binding names that resolve to enum base classes. */
  enumBaseNames: Set<string>;
}

function parseParams(parameters: TsNode | null): PyParam[] {
  if (!parameters) return [];
  const params: PyParam[] = [];
  for (const child of parameters.namedChildren) {
    if (child.type === "list_splat_parameter") {
      const name = child.namedChildren[0];
      if (name) params.push({ name: name.text, annotation: null, default: null, kind: "vararg" });
      continue;
    }
    if (child.type === "dictionary_splat_parameter") {
      const name = child.namedChildren[0];
      if (name) params.push({ name: name.text, annotation: null, default: null, kind: "kwarg" });
      continue;
    }
    if (child.type === "typed_parameter") {
      const [name, type] = child.namedChildren;
      if (name) params.push({ name: name.text, annotation: unwrapType(type), default: null, kind: "plain" });
      continue;
    }
    if (child.type === "typed_default_parameter") {
      const [name, type, value] = child.namedChildren;
      if (name) params.push({ name: name.text, annotation: unwrapType(type), default: value ?? null, kind: "plain" });
      continue;
    }
    if (child.type === "default_parameter") {
      const [name, value] = child.namedChildren;
      if (name) params.push({ name: name.text, annotation: null, default: value ?? null, kind: "plain" });
      continue;
    }
    if (child.type === "required_parameter" || child.type === "identifier") {
      params.push({ name: child.text, annotation: null, default: null, kind: "plain" });
    }
  }
  return params;
}

function parseClass(node: TsNode, file: string): PyClass {
  const nameNode = node.childForFieldName("name") ?? firstChildOfType(node, "identifier");
  const bases: TsNode[] = [];
  const argumentList = firstChildOfType(node, "argument_list");
  if (argumentList) bases.push(...argumentList.namedChildren);

  const fields: PyField[] = [];
  const block = node.childForFieldName("body") ?? firstChildOfType(node, "block");
  if (block) {
    for (const statement of childrenOfType(block, "expression_statement")) {
      const assignment = firstChildOfType(statement, "assignment");
      if (!assignment) continue;
      const name = assignment.namedChildren[0];
      const typeWrapper = childrenOfType(assignment, "type")[0] ?? null;
      if (!name || name.type !== "identifier") continue;
      // assignment children: name identifier, optional type wrapper, optional value.
      const value = assignment.namedChildren.find(
        (child, index) => index > 0 && child.type !== "type",
      );
      fields.push({
        name: name.text,
        annotation: unwrapType(typeWrapper),
        default: value ?? null,
      });
    }
  }

  return {
    name: nameNode?.text ?? "",
    file,
    node,
    bases,
    fields,
  };
}

function parseFunction(node: TsNode, file: string, decorated: TsNode | null, decorators: TsNode[]): PyFunction {
  const nameNode = node.childForFieldName("name") ?? firstChildOfType(node, "identifier");
  const parameters = node.childForFieldName("parameters") ?? firstChildOfType(node, "parameters");
  const returnTypeRaw = node.childForFieldName("return_type") ?? firstChildOfType(node, "type");
  const body = node.childForFieldName("body") ?? firstChildOfType(node, "block");
  return {
    name: nameNode?.text ?? "",
    file,
    node,
    decorated,
    decorators,
    params: parseParams(parameters),
    returnType: unwrapType(returnTypeRaw),
    body,
  };
}

function collectImports(root: TsNode): Map<string, PyImportedName> {
  const imports = new Map<string, PyImportedName>();
  for (const statement of root.namedChildren) {
    if (statement.type === "import_statement") {
      for (const imported of findAll(statement, (n) =>
        ["dotted_name", "aliased_import"].includes(n.type),
      )) {
        if (imported.type === "aliased_import") {
          const [moduleNode, aliasNode] = imported.namedChildren;
          if (moduleNode && aliasNode) imports.set(aliasNode.text.split(/\s+as\s+/)[0] ?? aliasNode.text, {
            module: moduleNode.text,
            importedName: null,
          });
          const alias = firstChildOfType(imported, "alias");
          if (moduleNode && alias) imports.set(alias.text, { module: moduleNode.text, importedName: null });
        } else {
          const top = imported.text.split(".")[0];
          if (top) imports.set(top, { module: imported.text, importedName: null });
        }
      }
    }
    if (statement.type === "import_from_statement") {
      const moduleNode = statement.namedChildren[0];
      const moduleText = moduleNode?.text ?? "";
      for (const child of statement.namedChildren.slice(1)) {
        if (child.type === "dotted_name") {
          imports.set(child.text, { module: moduleText, importedName: child.text });
        } else if (child.type === "aliased_import") {
          const [original, alias] = child.namedChildren;
          const aliasNode = firstChildOfType(child, "alias");
          const binding = aliasNode?.text ?? alias?.text ?? original?.text ?? "";
          if (original && binding) imports.set(binding, { module: moduleText, importedName: original.text });
        }
      }
    }
  }
  return imports;
}

export async function createPythonAnalysis(
  ctx: ScanContext,
): Promise<PythonAnalysis | null> {
  const pyFiles = ctx.index.files.filter((file) => file.language === "python");
  if (!pyFiles.length) return null;

  const files = new Map<string, PyFile>();
  const classes: PyClass[] = [];
  const functions: PyFunction[] = [];
  const pydanticBaseNames = new Set<string>();
  const enumBaseNames = new Set<string>();

  for (const file of pyFiles) {
    const root = await parseSource("python", file.content);
    const imports = collectImports(root);
    files.set(file.path, { path: file.path, content: file.content, root, imports });

    for (const [binding, descriptor] of imports) {
      if (
        descriptor.module === "pydantic" &&
        (descriptor.importedName === "BaseModel" ||
          descriptor.importedName === "BaseSettings")
      ) {
        pydanticBaseNames.add(binding);
      }
      if (
        descriptor.module === "enum" &&
        ["Enum", "StrEnum", "IntEnum", "Flag"].includes(
          descriptor.importedName ?? "",
        )
      ) {
        enumBaseNames.add(binding);
      }
    }

    for (const classNode of findAll(root, (n) => n.type === "class_definition")) {
      classes.push(parseClass(classNode, file.path));
    }

    for (const decorated of findAll(root, (n) => n.type === "decorated_definition")) {
      const decorators = childrenOfType(decorated, "decorator");
      const definition = decorated.namedChildren[decorated.namedChildren.length - 1];
      if (definition?.type === "function_definition") {
        functions.push(parseFunction(definition, file.path, decorated, decorators));
      }
    }
    // Undecorated module/class functions can still be referenced as handlers.
    for (const fn of findAll(root, (n) => n.type === "function_definition")) {
      if (functions.some((candidate) => candidate.node === fn)) continue;
      functions.push(parseFunction(fn, file.path, null, []));
    }
  }

  // `import pydantic` style: attribute bases resolve through this binding.
  for (const file of files.values()) {
    if (file.imports.has("pydantic")) pydanticBaseNames.add("pydantic.BaseModel");
    if (file.imports.has("enum")) enumBaseNames.add("enum.Enum");
  }

  return {
    id: "python",
    files,
    classes,
    functions,
    pydanticBaseNames,
    enumBaseNames,
  };
}
