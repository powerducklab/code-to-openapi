import {expect,it} from 'vitest';
import {parseSource} from '../src/lang/treesitter/runtime.js';
import {resolveGoPackageFunction} from '../src/lang/go/symbols.js';
import {findAll} from '../src/lang/treesitter/ast.js';
import type {GoAnalysis} from '../src/lang/go/index.js';
it('resolves package functions by import identity, never first matching name',async()=>{
 const definitions=[['main.go','main','package main\nimport handlers "example.com/app/handlers"\nimport external "example.net/other/handlers"\nfunc Handle(){}'],['handlers/routes.go','handlers','package handlers\nfunc Handle(){}'],['other/routes.go','handlers','package handlers\nfunc Handle(){}']];
 const files=new Map();const functions=new Map();
 for(const [path,packageName,source]of definitions){const root=await parseSource('go',source!);files.set(path,{path,packageName,root,content:source});for(const node of findAll(root,n=>n.type==='function_declaration')){const name=node.namedChildren[0]!.text;const entry={name,file:path,node,body:node.namedChildren.find(n=>n.type==='block'),receiver:null};functions.set(name,[...(functions.get(name)??[]),entry]);}}
 const analysis={files,functions,modulePath:'example.com/app'} as unknown as GoAnalysis;
 const owner=files.get('main.go');
 expect(resolveGoPackageFunction(analysis,owner,undefined,'Handle')?.file).toBe('main.go');
 expect(resolveGoPackageFunction(analysis,owner,'handlers','Handle')?.file).toBe('handlers/routes.go');
 expect(resolveGoPackageFunction(analysis,owner,'external','Handle')).toBeUndefined();
 expect(resolveGoPackageFunction(analysis,undefined,undefined,'Handle')).toBeUndefined();
});
