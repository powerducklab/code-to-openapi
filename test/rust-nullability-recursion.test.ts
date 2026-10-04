import { expect, it } from 'vitest';
import { parseSource } from '../src/lang/treesitter/runtime.js';
import { extractTypeDef } from '../src/lang/rust/index.js';
import { rustTypeToSchema, type RustModelIndex } from '../src/lang/rust/schema.js';

it('preserves explicit null for optional primitive, object and nested container values', async () => {
 const root = await parseSource('rust', 'struct Child { id: i32 } struct Input { name: Option<String>, child: Option<Child>, values: Vec<Option<i32>> }');
 const defs = root.namedChildren.map(extractTypeDef).filter(x => x !== null);
 const model: RustModelIndex = { byName: new Map(defs.map(d => [d.name, d])), components: new Map() };
 const input = model.byName.get('Input')!;
 const schemas = input.fields.map(f => rustTypeToSchema(f.typeNode, model));
 expect(schemas).toEqual([{ type: ['string', 'null'] }, { anyOf: [{ $ref: '#/components/schemas/Child' }, { type: 'null' }] }, { type: 'array', items: { type: ['integer','null'], format: 'int32' } }]);
});
it('bounds recursive generic DTOs and self-referential substitutions', async () => {
 const root = await parseSource('rust', 'struct Node<T> { value: T, next: Option<Box<Node<T>>> } struct Input { node: Node<String> }');
 const defs = root.namedChildren.map(extractTypeDef).filter(x => x !== null);
 const model: RustModelIndex = { byName: new Map(defs.map(d => [d.name, d])), components: new Map() };
 const schema = rustTypeToSchema(model.byName.get('Input')!.fields[0]!.typeNode, model);
 expect(schema).toMatchObject({ type:'object', properties:{ value:{type:'string'}, next:{} } });
 const param = model.byName.get('Node')!.fields[0]!.typeNode;
 expect(rustTypeToSchema(param, model, new Set(), 0, new Map([['T', param]]))).toEqual({});
});

it('separates Serde input defaults from conditional output presence', async () => {
 const { rustSerializationIndex } = await import('../src/lang/rust/schema.js');
 const root = await parseSource('rust', `struct Data {
  optional: Option<String>,
  #[serde(default)] count: i32,
  #[serde(skip_serializing_if = "Option::is_none")] omitted: Option<String>,
  #[serde(skip_serializing)] secret: String,
  #[serde(skip_deserializing)] generated: i32,
  #[serde(skip)] ignored: String
 } struct Input { data: Data }`);
 const defs = root.namedChildren.map(extractTypeDef).filter(x => x !== null);
 const model: RustModelIndex = { byName: new Map(defs.map(d => [d.name, d])), components: new Map() };
 const type = model.byName.get('Input')!.fields[0]!.typeNode;
 rustTypeToSchema(type, model);
 rustTypeToSchema(type, rustSerializationIndex(model));
 expect(model.components.get('Data')!.required).toEqual(['secret']);
 expect(model.components.get('Data')!.properties).not.toHaveProperty('generated');
 expect(model.components.get('serialized_Data')!.required).toEqual(['optional','count','generated']);
 expect(model.components.get('serialized_Data')!.properties).not.toHaveProperty('secret');
 expect(model.components.get('serialized_Data')!.properties).not.toHaveProperty('ignored');
});

it('applies container Serde naming/defaults and default generic arguments',async()=>{
 const {rustSerializationIndex}=await import('../src/lang/rust/schema.js');
 const root=await parseSource('rust',`#[serde(rename_all="camelCase", default)]
 struct Payload { tag_list: Vec<String>, optional_value: Option<String>, #[serde(rename="explicit")] custom_name: i32 }
 struct Body<T=Payload>{value:T}
 struct Input{body:Body}`);
 const defs=root.namedChildren.filter(n=>n.type==='struct_item').map(extractTypeDef).filter(x=>x!==null);
 const model:RustModelIndex={byName:new Map(defs.map(d=>[d.name,d])),components:new Map()};
 const type=model.byName.get('Input')!.fields[0]!.typeNode;
 const input=rustTypeToSchema(type,model) as any;
 expect(input.properties.value.$ref).toBe('#/components/schemas/Payload');
 expect(model.components.get('Payload')!.required).toBeUndefined();
 expect(Object.keys(model.components.get('Payload')!.properties!)).toEqual(['tagList','optionalValue','explicit']);
 const output=rustTypeToSchema(type,rustSerializationIndex(model)) as any;
 expect(output.properties.value.$ref).toBe('#/components/schemas/serialized_Payload');
 expect(model.components.get('serialized_Payload')!.required).toEqual(['tagList','optionalValue','explicit']);
});

it('models Serde newtypes, tuples and proven custom string serialization',async()=>{
 const {rustSerializationIndex}=await import('../src/lang/rust/schema.js');
 const root=await parseSource('rust',`use serde::{Serialize,Serializer};
 struct Id(String);struct Pair(String,i32);struct Custom(i64);
 impl Serialize for Custom{fn serialize<S>(&self,serializer:S)->Result<S::Ok,S::Error> where S:Serializer{serializer.collect_str(&self.0)}}
 struct Input{id:Id,pair:Pair,custom:Custom}`);
 const defs=root.namedChildren.filter(n=>n.type==='struct_item').map(extractTypeDef).filter(x=>x!==null);
 const model:RustModelIndex={byName:new Map(defs.map(d=>[d.name,d])),components:new Map()};
 const output=rustSerializationIndex(model);
 const fields=model.byName.get('Input')!.fields;
 fields.forEach(f=>rustTypeToSchema(f.typeNode,output));
 expect(model.components.get('serialized_Id')).toEqual({type:'string'});
 expect(model.components.get('serialized_Pair')).toEqual({type:'array',prefixItems:[{type:'string'},{type:'integer',format:'int32'}],minItems:2,maxItems:2});
 expect(rustTypeToSchema(fields[2]!.typeNode,output)).toEqual({type:'string'});
});
