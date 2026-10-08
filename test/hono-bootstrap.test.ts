import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {scanProject} from '../src/index.js';
it('follows nested bootstrap helpers but ignores uncalled helpers and shadowed parameters',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hono-bootstrap-'));
 try {
  await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{hono:'4','@hono/zod-openapi':'0.16'}}));
  await writeFile(join(root,'index.ts'),`import {OpenAPIHono} from '@hono/zod-openapi'; import bootstrap from './bootstrap';
const app = new OpenAPIHono(); bootstrap(app);
`);
  await writeFile(join(root,'bootstrap.ts'),`import {addRoutes} from './routes';
export default function(app:any){addRoutes(app)}
`);
  await writeFile(join(root,'contract.ts'),"import {createRoute} from '@hono/zod-openapi'; const entity='users'; export const route=createRoute({method:'get',path:`/${entity}/{id}`,responses:{200:{description:'OK'}}});");
  await writeFile(join(root,'routes.ts'),`import {route as userRoute} from './contract';
export function addRoutes(app:any){
 app.openapi(userRoute,c=>c.json({id:'a'}));
 app.get('/health',c=>c.json({status:'ok'}));
 function ignored(app:any){app.get('/wrong',c=>c.json({wrong:true}))}
}
export function neverCalled(app:any){app.get('/unused',c=>c.json({unused:true}))}
`);
  const result=await scanProject({root,frameworks:['hono']});
  expect(result.project.operations.map(op=>op.path).sort()).toEqual(['/health','/users/{id}']);
  expect(result.project.operations.find(op=>op.path==='/health')!.responses[0]?.content?.[0]?.schema).toMatchObject({properties:{status:{type:'string'}}});
 }finally{await rm(root,{recursive:true,force:true});}
});
