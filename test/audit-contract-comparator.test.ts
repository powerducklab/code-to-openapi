import {expect,it} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

it('compares nullable references semantically while retaining genuine missing-field failures',()=>{
 const root=mkdtempSync(join(tmpdir(),'contract-comparison-'));
 try{
  const document=(schema:any,components={})=>({paths:{'/items':{get:{responses:{'200':{content:{'application/json':{schema}}}}}}},components});
  const expected=document({type:['object','null'],'x-audit-exact-properties':true,properties:{state:{type:'string',enum:['Ready','New']}},required:['state']});
  const actual=document({anyOf:[{$ref:'#/components/schemas/Alias'},{type:'null'}]}, {schemas:{Alias:{$ref:'#/components/schemas/Item'},Item:{type:'object',properties:{state:{type:'string',enum:['New','Ready']}},required:['state']}}});
  const a=join(root,'expected.json'),b=join(root,'actual.json'),out=join(root,'result.json');
  writeFileSync(a,JSON.stringify(expected));writeFileSync(b,JSON.stringify(actual));
  const run=()=>{execFileSync(process.execPath,['--import','tsx',resolve('examples/audit-contracts.ts'),a,b,out]);return JSON.parse(readFileSync(out,'utf8'));};
  expect(run().mismatches).toBe(0);
  (actual.components as any).schemas.Item.properties.phantom={type:'string'};writeFileSync(b,JSON.stringify(actual));
  expect(run().errors).toContainEqual(expect.objectContaining({field:'/propertyNames'}));
  (actual.components as any).schemas.Item.properties={};writeFileSync(b,JSON.stringify(actual));
  expect(run().errors).toContainEqual(expect.objectContaining({field:'/properties/state/present'}));
 }finally{rmSync(root,{recursive:true,force:true});}
});
