import {expect,it} from 'vitest';
import {namespaceComponents,remapSchemaReferences} from '../src/core/schema-references.js';
it('namespaces recursive components without collisions or rewriting descriptive strings',()=>{
 const schemas=new Map([['Data',{type:'object',properties:{child:{$ref:'#/components/schemas/Data'}},description:'#/components/schemas/Data'}]]);
 const result=namespaceComponents(schemas,new Set(['serialized_Data']),'serialized');
 expect(result.names.get('Data')).toBe('serialized_Data_2');
 expect(result.components[0]!.schema).toEqual({type:'object',properties:{child:{$ref:'#/components/schemas/serialized_Data_2'}},description:'#/components/schemas/Data'});
 expect(remapSchemaReferences({schema:{$ref:'#/components/schemas/Data'}},result.names)).toEqual({schema:{$ref:'#/components/schemas/serialized_Data_2'}});
 expect(schemas.get('Data')!.properties.child.$ref).toBe('#/components/schemas/Data');
});
