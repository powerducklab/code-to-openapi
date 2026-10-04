import {expect,it} from 'vitest';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('matches Fetch media types and empty bodies, excluding uncalled nested handlers',async()=>{
 const root=await mkdtemp(join(tmpdir(),'next-fetch-'));
 try{
 await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{next:'^14'}}));
 await mkdir(join(root,'app/api/items'),{recursive:true});
 await writeFile(join(root,'app/api/items/route.ts'),`
export function GET(){function unused(){return new Response('unused',{status:418});} return new Response(JSON.stringify({id:1}));}
export function POST(){return new Response(JSON.stringify({id:1}),{status:201,headers:{'Content-Type':'application/json'}});}
export function PATCH(){return new Response(null,{status:200});}
export function DELETE(){return new Response('bad',{status:400});}
`);
 const result=await scanProject({root}); const converted=await result.convert();expect(converted.documentValid).toBe(true);
 const doc=converted.document as any;const routes=doc.paths['/api/items'];
 const observed=new Response(JSON.stringify({id:1}));
 expect(observed.headers.get('content-type')).toBe('text/plain;charset=UTF-8');
 expect(routes.get.responses['200'].content['text/plain'].schema).toEqual({type:'string'});
 expect(routes.get.responses['418']).toBeUndefined();
 expect(routes.post.responses['201'].content['application/json'].schema.properties.id.type).toBe('number');
 expect(new Response(null).headers.get('content-type')).toBeNull();
 expect(routes.patch.responses['200'].content).toBeUndefined();
 expect(routes.delete.responses['400'].content['text/plain'].schema).toEqual({type:'string'});
 }finally{await rm(root,{recursive:true,force:true});}
});
it('reads proven Next query/header sources, image responses and raw webhook bodies',async()=>{
 const root=await mkdtemp(join(tmpdir(),'next-inputs-'));
 try{
 await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{next:'^14',zod:'^3'}}));
 await mkdir(join(root,'app/api/image'),{recursive:true});
 await writeFile(join(root,'app/api/image/route.ts'),`
import {z} from 'zod';
import {headers as requestHeaders} from 'next/headers';
import {ImageResponse as Image} from '@vercel/og';
const search=z.object({heading:z.string(),mode:z.enum(['light','dark']).default('dark')});
export function GET(req:Request){const url=new URL(req.url);const values=search.parse(Object.fromEntries(url.searchParams));return new Image(values);}
export async function POST(req:Request){const body=await req.text();const signature=requestHeaders().get('Stripe-Signature');return new Response(null);}
`);
 const result=await scanProject({root});const converted=await result.convert();expect(converted.documentValid).toBe(true);
 const doc=converted.document as any;const routes=doc.paths['/api/image'];
 expect(routes.get.parameters.find((p:any)=>p.name==='mode')).toMatchObject({in:'query',schema:{default:'dark'}});
 expect(routes.get.parameters.find((p:any)=>p.name==='mode').required).not.toBe(true);
 expect(routes.get.parameters.find((p:any)=>p.name==='heading').required).toBe(true);
 expect(routes.get.responses['200'].content['image/png'].schema).toMatchObject({type:'string',format:'binary'});
 expect(routes.post.parameters.find((p:any)=>p.name==='stripe-signature').in).toBe('header');
 expect(routes.post.requestBody.content['*/*'].schema).toEqual({type:'string'});
 }finally{await rm(root,{recursive:true,force:true});}
});
it('does not treat a local Response class or ignored safeParse as framework contracts',async()=>{
 const root=await mkdtemp(join(tmpdir(),'next-shadow-'));
 try{
 await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{next:'^14',zod:'^3'}}));
 await mkdir(join(root,'app/api/custom'),{recursive:true});
 await writeFile(join(root,'app/api/custom/route.ts'),`
import {z} from 'zod';class Response { constructor(value:unknown){} }
const payload=z.object({password:z.string()});
export async function POST(req:Request){const json=await req.json();payload.safeParse(json);return new Response(json);}
`);
 const result=await scanProject({root});
 expect(result.project.operations[0]?.gaps).toContain('body-schema-unknown');
 expect(result.project.operations[0]?.gaps).toContain('response-unknown');
 }finally{await rm(root,{recursive:true,force:true});}
});
