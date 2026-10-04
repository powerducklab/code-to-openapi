import {expect,it} from 'vitest';
import ts from 'typescript';
import {z} from 'zod';
import {convertZodNode} from '../src/lang/typescript/zod.js';
function schema(expression:string,mode:'input'|'output'='input'){
 const source=ts.createSourceFile('contract.ts',`const contract=${expression}`,ts.ScriptTarget.Latest,true);
 const statement=source.statements[0] as ts.VariableStatement;
 return convertZodNode(statement.declarationList.declarations[0]!.initializer,{ts,sourceFile:source,resolveSchemaBinding:()=>null,mode}) as any;
}
it('distinguishes defaults accepted on input from guaranteed parsed output',()=>{
 const actual=z.object({mode:z.enum(['light','dark']).default('dark')});
 expect(actual.parse({})).toEqual({mode:'dark'});
 expect(schema("z.object({mode:z.enum(['light','dark']).default('dark')})").required).toBeUndefined();
 expect(schema("z.object({mode:z.enum(['light','dark']).default('dark')})",'output').required).toEqual(['mode']);
});
it('matches exact-length validation and overlapping unions',()=>{
 expect(z.string().length(3).safeParse('ab').success).toBe(false);
 expect(z.string().length(3).safeParse('abc').success).toBe(true);
 expect(schema('z.string().length(3)')).toMatchObject({minLength:3,maxLength:3});
 expect(z.union([z.string(),z.literal('x')]).parse('x')).toBe('x');
 expect(schema("z.union([z.string(),z.literal('x')])").anyOf).toHaveLength(2);
});
it('removes stale required keys after optional overrides and omit',()=>{
 expect(z.object({a:z.string()}).merge(z.object({a:z.string().optional()})).parse({})).toEqual({});
 expect(schema('z.object({a:z.string()}).merge(z.object({a:z.string().optional()}))').required).toBeUndefined();
 expect(schema('z.object({a:z.string()}).omit({a:true})').required).toBeUndefined();
});
it('retains uncertain fields and union alternatives instead of silently narrowing',()=>{
 expect(schema('z.object({value:unknownSchema()})').properties).toEqual({value:{}});
 expect(schema('z.union([z.string(),unknownSchema()])').anyOf).toEqual([{type:'string'},{}]);
 expect(()=>schema('z.string().default()')).not.toThrow();
});
