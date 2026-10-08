import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { scanProject } from '../src/index.js';

it('resolves aliased cross-file fastify-zod registrations and keeps unrelated reference functions opaque', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fastify-zod-ref-'));
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { fastify: '*', 'fastify-zod': '*' } }));
    await writeFile(join(root, 'schemas.ts'), `import {z} from 'zod';
import {buildJsonSchemas as build} from 'fastify-zod';
const fields={label:z.string(),amount:z.number().optional()};
const Item=z.object({...fields,id:z.number()});
const Items=z.array(Item);
export const {$ref: lookup}=build({payload:Item,collection:Items});`);
    await writeFile(join(root, 'app.ts'), `import fastify from 'fastify';
import {lookup as schemaFor} from './schemas';
const app=fastify();
app.post('/inventory',{schema:{body:schemaFor('payload'),response:{201:schemaFor('collection')}}},async()=>external());
const $ref=(name)=>external(name);
app.get('/opaque',{schema:{response:{200:$ref('payload')}}},async()=>external());
app.get('/missing',{schema:{response:{200:schemaFor('absent')}}},async()=>external());`);
    const result = await scanProject({ root, frameworks: ['fastify'] });
    const op = result.project.operations.find(o => o.path === '/inventory')!;
    expect(op.requestBody?.content[0].schema).toMatchObject({type:'object',required:['label','id'],properties:{label:{type:'string'},amount:{type:'number'},id:{type:'number'}}});
    expect(op.responses.find(r=>r.statusCode==='201')?.content?.[0].schema).toMatchObject({type:'array',items:{properties:{label:{type:'string'},id:{type:'number'}}}});
    for (const path of ['/opaque','/missing']) expect(result.project.operations.find(o=>o.path===path)?.gaps).toContain('response-schema-unknown');
    expect((await result.convert({validate:true})).documentValid).toBe(true);
  } finally { await rm(root, {recursive:true,force:true}); }
});
