import {expect,it} from 'vitest';
import {fillSchemaGaps} from '../src/ai/schemaMerge.js';
it('fills unknown leaves without dropping siblings, required fields or constraints',()=>{
 const known:any={type:'object',properties:{name:{type:'string',minLength:3},result:{},rows:{type:'array',minItems:1}},required:['name','result']};
 const merged=fillSchemaGaps(known,{type:'object',properties:{result:{type:'integer'},rows:{type:'array',items:{type:'string'}}}},new Map());
 expect(merged).toEqual({...known,properties:{...known.properties,result:{type:'integer'},rows:{type:'array',minItems:1,items:{type:'string'}}}});
 expect(known.properties.result).toEqual({});
 expect(fillSchemaGaps(known,{type:'string'},new Map())).toEqual(known);
});
