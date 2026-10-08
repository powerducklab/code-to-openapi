import {expect,it} from 'vitest';
import {hasUnknownSchema} from '../src/core/completeness.js';
import {partialSchema} from '../src/core/partial-schema.js';
it('does not let a proven branch erase missing evidence in another branch',()=>{
 for(const keyword of ['anyOf','oneOf','allOf']){
  expect(hasUnknownSchema({[keyword]:[{type:'string'},{}]})).toBe(true);
  expect(hasUnknownSchema({[keyword]:[{type:'string'},{type:'null'}]})).toBe(false);
 }
 const shape={type:'object',properties:{id:{type:'integer'}},required:['id']};
 const partial=partialSchema(shape,'Dynamic association');
 expect(partial.properties).toEqual(shape.properties);
 expect(hasUnknownSchema(partial)).toBe(true);
 expect(hasUnknownSchema({$ref:'#/components/schemas/Item'},new Map([['Item',partial]]))).toBe(true);
 const transformed=partialSchema(shape,'Opaque serializer',true);
 expect(transformed.anyOf).toEqual([shape,{}]);
 expect(hasUnknownSchema(transformed)).toBe(true);
 const cyclic:any={type:'object',properties:{}};cyclic.properties.self=cyclic;
 expect(hasUnknownSchema(cyclic)).toBe(false);
 cyclic.properties.variant={anyOf:[cyclic,{}]};
 expect(hasUnknownSchema(cyclic)).toBe(true);
});
