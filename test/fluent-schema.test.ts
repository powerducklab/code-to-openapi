import { describe, expect, it } from "vitest";
import ts from "typescript";

import { convertFluentNode } from "../src/lang/typescript/fluentSchema.js";

// Parses `const schema = <code>;` and converts the initializer expression.
function convert(code: string) {
  const sourceFile = ts.createSourceFile(
    "schema.ts",
    `const schema = ${code};`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node)) {
      initializer = node.declarationList.declarations[0]?.initializer;
      return;
    }
    if (!initializer) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!initializer) throw new Error("no initializer parsed");
  return convertFluentNode(initializer, { ts });
}

describe("fluent-json-schema syntactic conversion", () => {
  it("converts bare static combinators and refs", () => {
    expect(convert("S.oneOf([S.string(), S.integer()])")).toEqual({
      oneOf: [{ type: "string" }, { type: "integer" }],
    });
    expect(convert("S.anyOf([S.string(), S.boolean()])")).toEqual({
      anyOf: [{ type: "string" }, { type: "boolean" }],
    });
    expect(convert('S.ref("#/definitions/Tag")')).toEqual({
      $ref: "#/definitions/Tag",
    });
  });

  it("keeps tail steps after a static combinator", () => {
    expect(convert('S.oneOf([S.string()]).description("either")')).toEqual({
      oneOf: [{ type: "string" }],
      description: "either",
    });
  });

  it("merges root-level raw extensions and strips $schema", () => {
    expect(convert("S.object().raw({ additionalProperties: false })")).toEqual({
      type: "object",
      additionalProperties: false,
    });
  });

  it("converts enum constraints and nested array item objects", () => {
    expect(convert('S.string().enum(["a", "b"])')).toEqual({
      type: "string",
      enum: ["a", "b"],
    });
    expect(
      convert("S.array().items(S.object().prop('id', S.integer()))"),
    ).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "integer" } },
      },
    });
  });

  it("converts not()", () => {
    expect(convert("S.not(S.string())")).toEqual({ not: { type: "string" } });
  });
});

it("distinguishes required object markers from the last declared child", () => {
  expect(convert("S.object().prop('a', S.object().prop('x', S.string()).required())")).toEqual({
    type: 'object', properties: { a: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } },
  });
  expect(convert("S.object().prop('a', S.object().required().prop('x', S.string()))")).toEqual({
    type: 'object', properties: { a: { type: 'object', properties: { x: { type: 'string' } } } }, required: ['a'],
  });
  expect(convert("S.object().prop('a', S.object().required(['x']).prop('x', S.string()))")).toEqual({
    type: 'object', properties: { a: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } },
  });
});
