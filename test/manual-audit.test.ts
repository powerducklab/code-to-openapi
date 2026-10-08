import {describe, it, expect} from 'vitest';
import {buildGapReview, applyGapDecision} from '../src/ai/review.js';
import {buildGapMessages, parseGapResolution} from '../src/ai/prompt.js';
const candidate:any = {method:'GET',path:'/items',fullPath:'/items',origin:{file:'handler.ts',line:3},handlerSource:'function handler(req,res) {res.json({ok:true})}',parameters:[],responses:[{statusCode:'200',content:[{mediaType:'application/json',schema:{type:'object',properties:{ok:{type:'boolean'}}}}]}],confidence:'high',gaps:[]};
describe('manual audit of deterministic contracts',()=>{
 it('offers optional review without pretending a high confidence route has gaps',()=>{
  expect(buildGapReview(candidate,[])).toBeNull();
  const review=buildGapReview(candidate,[],true)!;
  expect(review.gaps).toEqual([]); expect(review.request.audit).toBe(true);
  expect(buildGapMessages(review.request)[1].content).toContain('currentContract');
  expect(buildGapReview({...candidate,handlerSource:undefined},[],true)).toBeNull();
 });
 it('preserves findings for no-change and insufficient-evidence outcomes',()=>{
  const operation={...candidate,gaps:['response-unknown']}; const review=buildGapReview(operation,[],true)!;
  for(const outcome of ['no-change','insufficient-evidence']) {
   const resolution=parseGapResolution({outcome,confidence:'low',rationale:'Missing dependency'})!;
   expect(resolution.outcome).toBe(outcome);
   const result=applyGapDecision([operation],review,{action:'accept',resolution});
   expect(result.applied).toBe(false);expect(result.operation.gaps).toEqual(['response-unknown']);
  }
 });
 it('applies audited corrections only on acceptance, without mutating AST output',()=>{
  const review=buildGapReview(candidate,[],true)!;
  const resolution:any={responseSchemas:{'200':{type:'string'}},confidence:'high'};
  expect(applyGapDecision([candidate],review,{action:'reject',resolution}).operation).toEqual(candidate);
  const result=applyGapDecision([candidate],review,{action:'accept',resolution});
  expect(result.operation.responses[0].content![0].schema).toMatchObject({type:'string','x-ai-inferred':true});
  expect(candidate.responses[0].content[0].schema.type).toBe('object');
 });
});

it('ordinary gap completion includes the existing contract and referenced component schemas',()=>{
 const review=buildGapReview({...candidate,gaps:['response-schema-unknown'],responses:[{statusCode:'200',content:[{mediaType:'application/json',schema:{$ref:'#/components/schemas/Result'}}]}]},[{name:'Result',schema:{type:'object',properties:{id:{type:'string'}}}}])!;
 expect(review.request.audit).toBeUndefined();
 expect(review.request.contract?.responses).toEqual(expect.any(Array));
 expect(buildGapMessages(review.request)[1]!.content).toContain('"id"');
});

it('does not replace a proven request body while reviewing response gaps',()=>{
 const operation:any={...candidate,gaps:['response-schema-unknown'],requestBody:{required:true,content:[{mediaType:'application/json',schema:{type:'object',properties:{email:{type:'string',format:'email',minLength:1}},required:['email']}}]},responses:[{statusCode:'200',content:[{mediaType:'application/json',schema:{}}]}]};
 const review=buildGapReview(operation,[],true)!;
 const result=applyGapDecision([operation],review,{action:'accept',resolution:{bodySchema:{type:'object',properties:{email:{type:'string',format:'email'}}},confidence:'high'}});
 expect(result.operation.requestBody).toEqual(operation.requestBody);
 expect(result.operation.gaps).toContain('response-schema-unknown');
});

it('never synthesizes JSON for bodyless statuses or replaces non-JSON request content',()=>{
 const operation:any={...candidate,gaps:['body-schema-unknown','response-unknown'],requestBody:{content:[{mediaType:'application/xml',schema:{}}]},responses:[{statusCode:'302',description:'Redirect'}]};
 const review=buildGapReview(operation,[],true)!;
 const result=applyGapDecision([operation],review,{action:'accept',resolution:{bodySchema:{type:'string'},responseSchemas:{'204':{type:'string'},'302':{type:'string'}},confidence:'high'}});
 expect(result.operation.requestBody).toEqual(operation.requestBody);
 expect(result.operation.responses).toEqual(operation.responses);
 expect(result.applied).toBe(false);
 expect(result.gapsClosed).toEqual([]);
});

it('keeps response uncertainty when an unrelated body fix is accepted',()=>{
 const operation:any={...candidate,gaps:['body-schema-unknown','response-unknown'],requestBody:{content:[{mediaType:'application/json',schema:{}}]},responses:[{statusCode:'default',description:'Forward target unresolved'}]};
 const review=buildGapReview(operation,[],true)!;
 const result=applyGapDecision([operation],review,{action:'accept',resolution:{bodySchema:{type:'string'},responseSchemas:{default:{type:'string'}},confidence:'high'}});
 expect(result.operation.gaps).toContain('response-unknown');
 expect(result.gapsClosed).not.toContain('response-unknown');
});
