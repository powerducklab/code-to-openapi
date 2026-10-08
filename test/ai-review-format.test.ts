import {expect,it} from 'vitest';
import {parseGapResolution} from '../src/ai/prompt.js';
import type {GapRequest} from '../src/ai/gapResolver.js';
const request:Pick<GapRequest,'route'|'gaps'>={route:{method:'POST',path:'/{base}/mcp'},gaps:['body-schema-unknown']};
const schema={type:'object',properties:{jsonrpc:{const:'2.0'},method:{type:'string'}},required:['jsonrpc','method']};
const operation={requestBody:{content:{'application/json':{schema}}}};
it('accepts a standard OpenAPI body only for the exact requested operation',()=>{
 expect(parseGapResolution({openapi:'3.2.0',paths:{'/{base}/mcp':{post:operation}}},undefined,request)?.bodySchema).toEqual(schema);
 expect(parseGapResolution({openapi:'3.2.0',paths:{'/other':{post:operation}}},undefined,request)).toBeNull();
 expect(parseGapResolution({openapi:'3.2.0',paths:{'/{base}/mcp':{delete:operation}}},undefined,request)).toBeNull();
});
it('accepts a bare schema only for unambiguous body-only requests',()=>{
 expect(parseGapResolution(schema,undefined,request)?.bodySchema).toEqual(schema);
 expect(parseGapResolution(schema)).toBeNull();
 expect(parseGapResolution(schema,undefined,{...request,gaps:['response-schema-unknown']})).toBeNull();
});
it('does not treat non-JSON content or unapproved component references as JSON body evidence',()=>{
 expect(parseGapResolution({requestBody:{content:{'text/html':{schema}}}},undefined,request)).toBeNull();
 expect(parseGapResolution({requestBody:{content:{'application/json':{schema:{$ref:'#/components/schemas/Invented'}}}}},new Set(),request)).toBeNull();
});
it('rejects status acknowledgments and anchors body-only instructions after source evidence',async()=>{
 const {buildGapMessages}=await import('../src/ai/prompt.js');
 expect(parseGapResolution('{"status":"ok"}',new Set(),request)).toBeNull();
 const messages=buildGapMessages({...request,origin:{file:'app.ts',line:1},handlerSource:'async function handler(request){return delegate(request.body)}',known:{framework:'fastify',language:'typescript',pathParameters:[]}});
 expect(messages[0]!.content).toContain('asks ONLY for the request-body schema');
 expect(messages[0]!.content).not.toContain('"queryParameters": [');
 expect(messages[1]!.content.indexOf('END OF SOURCE EVIDENCE')).toBeGreaterThan(messages[1]!.content.indexOf('delegate(request.body)'));
 expect(messages[1]!.content).toContain('Return bodySchema, confidence and rationale');
});
