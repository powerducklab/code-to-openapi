import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import ts from 'typescript';
import {expect, it} from 'vitest';
import {createExternalSourceCollector} from '../src/ai/externalSourceContext.js';

function fixture() {
 const root=mkdtempSync(join(tmpdir(),'external-evidence-'));
 const write=(path:string,text:string)=>{const file=join(root,path);mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,text);return file;};
 const pkg=(name:string,source:string)=>{write(`node_modules/${name}/package.json`,JSON.stringify({type:'module',exports:{import:'./index.js',require:'./do-not-read.cjs'}}));write(`node_modules/${name}/index.js`,source);};
 return {root,write,pkg,collect:(source:string)=>createExternalSourceCollector(ts)([{file:join(root,'app.ts'),source}]),cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
it('follows aliased runtime factories and validators without executing packages or following shadowed minified imports',()=>{
 const f=fixture();try {
 f.pkg('host',`import {Transport as T} from 'transport'; import {unrelated as x} from 'noise'; function h(){const x=1;return new T(x)} export {h as createHost}; throw new Error('must never execute');`);
 f.pkg('noise',`export function unrelated(){return 'UNRELATED_EVIDENCE'}`);
 f.pkg('transport',`import {MessageSchema} from './schema.js'; export class Transport {handle(body){return MessageSchema.parse(body)}}`);
 f.write('node_modules/transport/schema.js',`const VERSION='2.0'; const Request={jsonrpc:VERSION,method:'string'}; export const MessageSchema={parse(body){return Request}};`);
 const result=f.collect(`import {createHost} from 'host';const host=createHost();export function handler(body){return host.handle(body)}`);
 const evidence=result.files.map(x=>x.source).join('\n');
 expect(evidence).toContain('MessageSchema.parse(body)');expect(evidence).toContain("VERSION='2.0'");
 expect(evidence).toContain('createHost = h');expect(evidence).not.toContain('UNRELATED_EVIDENCE');
 expect(result.files.every(x=>x.contentHash?.length===64)).toBe(true);
 }finally{f.cleanup()}
});
it('ignores type-only dependencies and preserves re-export chains',()=>{
 const f=fixture();try{
 f.pkg('gateway',`export {handle as accept} from './handler.js';`);
 f.write('node_modules/gateway/handler.js',`export function handle(body){return {received:body}}`);
 f.pkg('types-only',`throw new Error('types are not runtime evidence')`);
 const r=f.collect(`import {accept} from 'gateway';import {Type} from 'types-only';type Result=ReturnType<typeof Type>;accept({});`);
 expect(r.files.some(x=>x.source.includes('received:body'))).toBe(true);
 expect(r.files.some(x=>x.file.includes('types-only'))).toBe(false);
 }finally{f.cleanup()}
});
it('bounds cyclic runtime traversal and reports unsupported or missing evidence',()=>{
 const f=fixture();try{
 f.pkg('loop',`import {other} from './other.js';export function run(body){return other(body)}`);
 f.write('node_modules/loop/other.js',`import {run} from './index.js';export function other(body){return run(body)}`);
 const r=f.collect(`import {run} from 'loop';import {missing} from 'absent';run(missing());`);
 expect(r.files.length).toBeLessThanOrEqual(12);expect(r.files.reduce((n,x)=>n+x.source.length,0)).toBeLessThanOrEqual(32000);
 expect(r.limitations).toContain('Installed runtime source unavailable: absent');
 }finally{f.cleanup()}
});
it('finds request parsing in large transport classes instead of spending all space on lifecycle methods',()=>{
 const f=fixture();try{
 f.pkg('transport',`import {BodySchema} from './schema.js';export class Transport { lifecycle(){${'void 0;'.repeat(2000)}} handlePostRequest(body){return BodySchema.parse(body)} }`);
 f.write('node_modules/transport/schema.js',`export const BodySchema={parse(body){return {type:'object',body}}};`);
 const r=f.collect(`import {Transport} from 'transport';new Transport().handlePostRequest({});`);
 expect(r.files.map(x=>x.source).join('\n')).toContain('BodySchema={parse(body)');expect(r.files.some(x=>x.truncated)).toBe(true);
 }finally{f.cleanup()}
});
it('carries a delegated class binding into a late project dependency excerpt and includes runtime evidence in the AI prompt',async()=>{
 const {scanProject,buildGapMessages}=await import('../src/index.js');
 const f=fixture();try{
 f.write('package.json',JSON.stringify({dependencies:{fastify:'*'}}));
 f.write('app.ts',`import Fastify from 'fastify';import {HostManager} from './host.js';const app=Fastify();const manager=new HostManager();app.post('/gateway',async(request,reply)=>{await manager.handle(request.body,reply)});`);
 f.write('host.ts',`import {createHost} from 'host';\nfunction unrelated(){${'void 0;'.repeat(1500)}}\nexport class HostManager {handle(body:any,reply:any){return createHost().handle(body,reply)}}`);
 f.pkg('host',`import {InputSchema} from './schema.js';export function createHost(){return {handle(body,reply){return reply.send(InputSchema.parse(body))}}}`);
 f.write('node_modules/host/schema.js',`export const InputSchema={parse(value){return {message:value.message}}};`);
 const r=await scanProject({root:f.root,aiReview:'manual',reviewAll:true});
 const q=r.gapReviews!.find(x=>x.path==='/gateway')!;
 const payload=buildGapMessages(q.request)[1]!.content;
 expect(payload).toContain('InputSchema.parse(body)');expect(payload).toContain('message:value.message');
 expect(q.request.sourceContext!.files.reduce((n,x)=>n+x.source.length,0)).toBeLessThanOrEqual(24000);
 }finally{f.cleanup()}
});
it('preserves strict object constraints inside protocol unions during proposal sanitizing',async()=>{
 const {sanitizeSchema}=await import('../src/ai/prompt.js');
 const schema={anyOf:[{type:'object',properties:{jsonrpc:{const:'2.0'},method:{type:'string'}},required:['jsonrpc','method'],additionalProperties:false},{type:'object',properties:{result:{type:'object',additionalProperties:true}},required:['result']}]};
 expect(sanitizeSchema(schema)).toMatchObject({anyOf:[{additionalProperties:false,required:['jsonrpc','method']},{properties:{result:{type:'object',additionalProperties:{}}}}]});
});
