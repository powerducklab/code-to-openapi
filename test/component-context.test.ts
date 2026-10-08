import {describe,it,expect} from 'vitest';
import {selectComponentContext} from '../src/ai/componentContext.js';
import {gapCacheKey} from '../src/ai/gapResolver.js';
describe('bounded dependency evidence',()=>{
 it('includes referenced schema closure and terminates circular references',()=>{
  const context=selectComponentContext({handlerSource:'return User',componentCatalog:[{name:'User',schema:{properties:{address:{$ref:'#/components/schemas/Address'}}}},{name:'Address',schema:{properties:{owner:{$ref:'#/components/schemas/User'}}}},{name:'Unrelated',schema:{type:'string'}}]});
  expect(context.components.map(c=>c.name)).toEqual(['User','Address']);expect(context.dependencySourceIncluded).toBe(false);
 });
 it('reports missing and oversized schemas without claiming complete evidence',()=>{
  const context=selectComponentContext({handlerSource:'Huge Missing',contract:{$ref:'#/components/schemas/Missing'},componentCatalog:[{name:'Huge',schema:{description:'x'.repeat(25000)}}]});
  expect(context.components).toHaveLength(0);expect(context.truncated).toBe(true);expect(context.omittedOrUnavailable).toEqual(expect.arrayContaining(['Huge','Missing']));
 });
 it('invalidates cached reviews when dependency schemas change',()=>{
  const request:any={route:{method:'GET',path:'/'},handlerSource:'return User',gaps:[],componentCatalog:[{name:'User',schema:{type:'string'}}]};
  const before=gapCacheKey(request,'v');request.componentCatalog[0].schema.type='number';expect(gapCacheKey(request,'v')).not.toBe(before);
 });
});
