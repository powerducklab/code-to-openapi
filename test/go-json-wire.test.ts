import {expect,it} from 'vitest';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';

it('matches Go encoding/json pointer, slice, byte, fixed-array and omission semantics',async()=>{
 const root=await mkdtemp(join(tmpdir(),'go-wire-'));
 try{
  const oracle=await readFile(new URL('../examples/oracles/go-json-wire/main.go',import.meta.url),'utf8');
  const structs=oracle.slice(oracle.indexOf('type Nested'),oracle.indexOf('func main'));
  await writeFile(join(root,'main.go'),`package main
import("encoding/json";"net/http")
${structs}
func handle(w http.ResponseWriter,r *http.Request){json.NewEncoder(w).Encode(Contract{})}
func main(){http.HandleFunc("/contract",handle)}
`);
  const result=await scanProject({root});const doc=(await result.convert()).document as any;
  const schema=doc.components.schemas.Contract;
  expect(schema.properties.pointer).toEqual({type:['string','null']});
  expect(schema.required).toContain('pointer');
  expect(schema.required).not.toContain('optional');
  expect(schema.properties.optional).toEqual({type:'string'});
  expect(schema.properties.slice).toEqual({type:['array','null'],items:{type:'string'}});
  expect(schema.properties.optionalSlice).toEqual({type:'array',items:{type:'string'}});
  expect(schema.properties.bytes).toEqual({type:['string','null'],contentEncoding:'base64'});
  expect(schema.properties.fixed).toEqual({type:'array',items:{type:'string'},minItems:2,maxItems:2});
  expect(schema.properties.map.type).toEqual(['object','null']);
  expect(schema.properties.quoted.type).toBe('string');
  expect(schema.required).toContain('object');
  expect(doc.components.schemas.Conflict.properties).toEqual({});
  expect(doc.components.schemas.TaggedWinner.properties).toEqual({Value:{type:'string'}});
  expect(doc.components.schemas.DepthWinner.properties).toEqual({Value:{type:'integer',format:'int64'}});
  expect(doc.components.schemas.NamedEmbedded.properties).toEqual({nested:{$ref:'#/components/schemas/Nested'}});
  expect(doc.components.schemas.HiddenEmbedded.properties).toEqual({});
  expect(schema.properties['-']).toEqual({type:'string'});
  expect(schema.required).not.toContain('-');
 }finally{await rm(root,{recursive:true,force:true});}
});

it('narrows initialized local slices only when no nil write or address escape is possible',async()=>{
 const root=await mkdtemp(join(tmpdir(),'go-slice-flow-'));
 try{
  await writeFile(join(root,'go.mod'),'module example\n\ngo 1.25\n\nrequire github.com/go-chi/chi/v5 v5.0.0\n');
  await writeFile(join(root,'main.go'),`package main
import("encoding/json";"net/http";"github.com/go-chi/chi/v5")
type Item struct{ Name string }
func safe(w http.ResponseWriter,r *http.Request){items:=[]Item{};items=append(items,Item{});json.NewEncoder(w).Encode(items)}
func nilWrite(w http.ResponseWriter,r *http.Request){items:=[]Item{};if r.Method=="GET"{items=nil};json.NewEncoder(w).Encode(items)}
func escaped(w http.ResponseWriter,r *http.Request){items:=[]Item{};mutate(&items);json.NewEncoder(w).Encode(items)}
func shadow(w http.ResponseWriter,r *http.Request){items:=[]Item{};append:=func(items []Item, item Item)[]Item{return nil};items=append(items,Item{});json.NewEncoder(w).Encode(items)}
func mutate(items *[]Item){*items=nil}
func main(){r:=chi.NewRouter();r.Get("/safe",safe);r.Get("/nil",nilWrite);r.Get("/escape",escaped);r.Get("/shadow",shadow)}
`);
  const result=await scanProject({root});const doc=(await result.convert()).document as any;
  const schema=(path:string)=>doc.paths[path].get.responses['200'].content['application/json'].schema;
  expect(schema('/safe').type).toBe('array');
  for(const path of ['/nil','/escape','/shadow'])expect(schema(path).type).toEqual(['array','null']);
 }finally{await rm(root,{recursive:true,force:true});}
});

it('follows an opaque assignment only when it definitely precedes serialization',async()=>{
 const root=await mkdtemp(join(tmpdir(),'go-assignment-'));
 try{
  await writeFile(join(root,'main.go'),`package main
import("encoding/json";"net/http")
type Payload struct{ Value string }
func build() interface{} {return Payload{Value:"ok"}}
func safe(w http.ResponseWriter,r *http.Request){var value interface{};value=build();json.NewEncoder(w).Encode(value)}
func conditional(w http.ResponseWriter,r *http.Request){var value interface{};if r.Method=="GET"{value=build()};json.NewEncoder(w).Encode(value)}
func overwritten(w http.ResponseWriter,r *http.Request){var value interface{};value=build();value=nil;json.NewEncoder(w).Encode(value)}
func future(w http.ResponseWriter,r *http.Request){var value interface{};json.NewEncoder(w).Encode(value);value=build()}
func main(){http.HandleFunc("/safe",safe);http.HandleFunc("/conditional",conditional);http.HandleFunc("/overwritten",overwritten);http.HandleFunc("/future",future)}
`);
  const doc=(await (await scanProject({root})).convert()).document as any;
  const schema=(path:string)=>doc.paths[path].get.responses['200'].content['application/json'].schema;
  expect(schema('/safe').$ref).toContain('Payload');
  for(const path of ['/conditional','/overwritten','/future'])expect(schema(path)?.$ref).toBeUndefined();
 }finally{await rm(root,{recursive:true,force:true});}
});
