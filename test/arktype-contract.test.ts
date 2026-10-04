import { expect, it } from "vitest";
import ts from "typescript";
import { convertArkNode, parseArkString } from "../src/lang/typescript/arktype.js";

it("preserves union branches, literals and strict numeric/array bounds", () => {
  expect(parseArkString("string | number | null")).toEqual({ anyOf: [{type:"string"}, {type:"number"}, {type:"null"}] });
  expect(parseArkString("string | undefined")).toEqual({type:"string", "x-optional":true});
  expect(parseArkString("'a|b'")).toEqual({type:"string", const:"a|b"});
  expect(parseArkString("number > 0")).toEqual({type:"number", exclusiveMinimum:0});
  expect(parseArkString("string[] >= 2")).toEqual({type:"array", items:{type:"string"}, minItems:2});
  expect(parseArkString("string < 2.5")).toEqual({type:"string", maxLength:2});
  expect(parseArkString("string.numeric.parse |> 1 <= number.integer <= 100")?.type).toBe("string");
  expect(parseArkString("string.numeric.parse |> 1 <= number.integer <= 100", "output")).toEqual({type:"integer", minimum:1, maximum:100});
  expect(parseArkString("string | Unknown")).toBeNull();
});
it("keeps unsupported fields and uses overwrite requiredness for merge", () => {
  const sourceFile = ts.createSourceFile("dto.ts", `const dto = type({ name: 'string', unsupported: customValidator }).merge({'name?':'string'});`, ts.ScriptTarget.Latest, true);
  const declaration = (sourceFile.statements[0] as ts.VariableStatement).declarationList.declarations[0]!;
  const schema = convertArkNode(declaration.initializer, {ts,sourceFile,resolveBinding:()=>null});
  expect(schema).toEqual({type:"object",properties:{name:{type:"string"},unsupported:{}}, required:["unsupported"]});
});
it('applies omit/pick before array without leaking removed fields or required keys',()=>{
 const sourceFile=ts.createSourceFile('dto.ts',`const dto=type({body:'string',title:'string','summary?':'string'}).omit('body').pick('title','summary').array();`,ts.ScriptTarget.Latest,true);
 const declaration=(sourceFile.statements[0] as ts.VariableStatement).declarationList.declarations[0]!;
 expect(convertArkNode(declaration.initializer,{ts,sourceFile,resolveBinding:()=>null})).toEqual({type:'array',items:{type:'object',properties:{title:{type:'string'},summary:{type:'string'}},required:['title']}});
 const invalid=ts.createSourceFile('bad.ts',`const dto=type({title:'string'}).omit(dynamicKey);`,ts.ScriptTarget.Latest,true);
 const reasons:string[]=[];
 expect(convertArkNode((invalid.statements[0] as ts.VariableStatement).declarationList.declarations[0]!.initializer,{ts,sourceFile:invalid,resolveBinding:()=>null,onUnresolved:message=>reasons.push(message)})).toBeNull();
 expect(reasons).toContain('Dynamic ArkType omit keys');
});
