import {expect,it} from 'vitest';
import {applyCompletenessGate} from '../src/core/completeness.js';
import type {RouteCandidate,JsonSchema} from '../src/core/types.js';
const candidate=():RouteCandidate=>({method:'get',path:'/items',fullPath:'/items',origin:{file:'test'},parameters:[],responses:[{statusCode:'200',description:'',confidence:'high',content:[{mediaType:'application/json',schema:{$ref:'#/components/schemas/Item'}}]}],tags:[],confidence:'high',gaps:[],components:[]});
it('reports unknown component fields behind refs for requests and responses',()=>{
 const schemas=new Map<string,JsonSchema>([['Item',{type:'object',properties:{data:{$ref:'#/components/schemas/Data'}}}],['Data',{}]]);
 const input=candidate();input.requestBody={required:true,confidence:'high',content:[{mediaType:'application/json',schema:{$ref:'#/components/schemas/Item'}}]};
 const result=applyCompletenessGate(input,schemas);
 expect(result.gaps).toContain('body-schema-unknown');expect(result.gaps).toContain('response-schema-unknown');expect(result.confidence).not.toBe('high');
 expect(applyCompletenessGate(candidate(),new Map()).gaps).toContain('response-schema-unknown');
});
it('terminates recursive schemas while still checking fields beyond the back edge',()=>{
 const item:JsonSchema={type:'object',properties:{parent:{$ref:'#/components/schemas/Item'},id:{type:'integer'}}};
 const schemas=new Map([['Item',item]]);
 expect(applyCompletenessGate(candidate(),schemas).gaps).not.toContain('response-schema-unknown');
 item.properties!.unknown={};
 expect(applyCompletenessGate(candidate(),schemas).gaps).toContain('response-schema-unknown');
});
it('handles a deep reference graph without consuming the JavaScript call stack',()=>{
 const schemas=new Map<string,JsonSchema>();
 for(let i=0;i<12000;i++)schemas.set(i===0?'Item':`N${i}`,i===11999?{type:'string'}:{$ref:`#/components/schemas/N${i+1}`});
 expect(applyCompletenessGate(candidate(),schemas).gaps).not.toContain('response-schema-unknown');
});

it('does not mistake annotations or untyped dictionary values for known contracts',()=>{
 for(const schema of [{readOnly:true},{description:'unknown', 'x-source':'dto'},{type:'object',additionalProperties:{writeOnly:true}}]){
  const schemas=new Map<string,JsonSchema>([['Item',schema]]);
  expect(applyCompletenessGate(candidate(),schemas).gaps).toContain('response-schema-unknown');
 }
 expect(applyCompletenessGate(candidate(),new Map([['Item',{type:'object',additionalProperties:false}]]))).toBeDefined();
});

it('does not certify a body whose media type is known but schema is absent',()=>{
 const input=candidate();
 input.requestBody={required:true,confidence:'high',content:[{mediaType:'application/json'}]};
 const result=applyCompletenessGate(input,new Map([['Item',{type:'string'}]]));
 expect(result.gaps).toContain('body-schema-unknown');
 expect(result.confidence).not.toBe('high');
});
it('does not certify array contracts with unproven element schemas',()=>{
 for(const schema of [{type:'array'},{type:['array','null']},{type:'array',prefixItems:[{type:'string'}]}]){
  expect(applyCompletenessGate(candidate(),new Map([['Item',schema]])).gaps).toContain('response-schema-unknown');
 }
 for(const schema of [{type:'array',items:{type:'string'}},{type:'array',maxItems:0},{type:'array',prefixItems:[{type:'string'}],maxItems:1}]){
  expect(applyCompletenessGate(candidate(),new Map([['Item',schema]])).gaps).not.toContain('response-schema-unknown');
 }
});
