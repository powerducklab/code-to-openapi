import ts from 'typescript';
import {expect,it} from 'vitest';
import {localValueDeclaration} from '../src/lang/typescript/staticValue.js';
import type {TsAnalysis} from '../src/lang/typescript/index.js';

it('falls back to enclosing JS scopes without borrowing names from siblings or skipping parameter shadowing',()=>{
 const source=ts.createSourceFile('scope.js',`const record='outer';
function first(){const record='inner'; use(record);}
function second(record){use(record);}
function sibling(){const isolated='private';}
function third(){use(record);use(isolated);}
`,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 const analysis={ts,checker:{getSymbolAtLocation:()=>undefined,getShorthandAssignmentValueSymbol:()=>undefined}} as unknown as TsAnalysis;
 const refs:ts.Identifier[]=[];
 const visit=(node:ts.Node):void=>{if(ts.isCallExpression(node))for(const arg of node.arguments)if(ts.isIdentifier(arg))refs.push(arg);ts.forEachChild(node,visit)};
 visit(source);
 expect(localValueDeclaration(analysis,refs[0]).initializer.text).toBe('inner');
 expect(ts.isParameter(localValueDeclaration(analysis,refs[1]))).toBe(true);
 expect(localValueDeclaration(analysis,refs[2]).initializer.text).toBe('outer');
 expect(localValueDeclaration(analysis,refs[3])).toBeUndefined();
});
