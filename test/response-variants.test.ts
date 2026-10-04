import {expect,it} from 'vitest';
import {mergeResponseVariants} from '../src/core/response-variants.js';
import type {JsonSchema,RouteCandidate} from '../src/core/types.js';
const response=(schema:JsonSchema):RouteCandidate['responses'][number]=>({statusCode:'200',description:'',confidence:'high',content:[{mediaType:'application/json',schema}]});
it('keeps constraints alongside unions and never narrows unknown branches',()=>{
 const first=response({type:'object',anyOf:[{required:['first']},{required:['second']}]});
 const before=JSON.stringify(first);
 const merged=mergeResponseVariants(first,response({type:'string'}));
 expect(merged.content![0]!.schema).toEqual({anyOf:[first.content![0]!.schema,{type:'string'}]});
 expect(JSON.stringify(first)).toBe(before);
 const unknown=mergeResponseVariants(merged,response({}));
 expect(unknown.content![0]!.schema?.anyOf).toContainEqual({});
});
it('retains distinct SSE event schemas without changing ordinary media schemas',()=>{
 const first:RouteCandidate['responses'][number]={statusCode:'200',description:'',confidence:'high',content:[{mediaType:'text/event-stream',itemSchema:{type:'object',properties:{first:{type:'string'}}}}]};
 const second:RouteCandidate['responses'][number]={...first,content:[{mediaType:'text/event-stream',itemSchema:{type:'object',properties:{second:{type:'integer'}}}}]};
 const result=mergeResponseVariants(first,second);
 expect(result.content![0]!.itemSchema).toEqual({anyOf:[first.content![0]!.itemSchema,second.content![0]!.itemSchema]});
 expect(result.content![0]!.schema).toBeUndefined();
 expect(first.content![0]!.itemSchema?.anyOf).toBeUndefined();
});
