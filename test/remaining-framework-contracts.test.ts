import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { scanProject } from '../src/index.js';
async function fixture(files: Record<string,string>, check: (doc:any,result:any)=>void) {
 const root=await mkdtemp(join(tmpdir(),'remaining-contract-'));
 try {
  for(const [path,source] of Object.entries(files)){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),source);}
  const result=await scanProject({root});const converted=await result.convert();
  expect(converted.documentValid,JSON.stringify(converted.diagnostics)).toBe(true);check(converted.document,result);
 } finally {await rm(root,{recursive:true,force:true});}
}
it('isolates Rocket module mounts and DTOs and binds data independently of format order',async()=>{
 await fixture({
  'src/json.rs':`use rocket::serde::json::Json; type Id=usize; struct Message<'r>{id:Option<Id>,message:std::borrow::Cow<'r,str>}
#[post("/", format="json", data="<message>")]
fn create(message:Json<Message<'_>>)->Option<Json<Message<'_>>>{Some(message)}
fn stage(){rocket.mount("/json",routes![create]);}`,
  'src/msgpack.rs':`use rocket::serde::msgpack::MsgPack; struct Message<'r>{id:usize,message:&'r str}
#[post("/", data="<message>", format="msgpack")]
fn create(message:MsgPack<Message<'_>>)->MsgPack<Message<'_>>{message}
fn stage(){rocket.mount("/msgpack",routes![create]);}`,
 },(doc)=>{
  expect(Object.keys(doc.paths).sort()).toEqual(['/json/','/msgpack/']);
  const json=doc.paths['/json/'].post,pack=doc.paths['/msgpack/'].post;
  const jref=json.requestBody.content['application/json'].schema.$ref.split('/').pop();
  const pref=pack.requestBody.content['application/msgpack'].schema.$ref.split('/').pop();
  expect(jref).not.toBe(pref);
  expect(doc.components.schemas[jref]).toMatchObject({required:['message'],properties:{id:{type:['integer','null'],format:'int64'},message:{type:'string'}}});
  expect(doc.components.schemas[pref].required).toEqual(['id','message']);
  expect(pack.responses['200'].content['application/msgpack']).toBeDefined();expect(json.responses['404']).toBeDefined();
 });
});
it('extracts FastEndpoints complex query keys, struct DTO and modern Send responses',async()=>{
 await fixture({'Api.cs':`using FastEndpoints;
class Search { [FromQuery] public Filters? Query {get;set;} }
class Filters {public int Id {get;set;} public Nested? Nested {get;set;} }
class Nested {public string? Name {get;set;} }
public struct Input {public int Id {get;init;} public string Title {get;init;} }
class Output {public int Count {get;set;} public string? Note {get;set;} }
class QueryEndpoint:Endpoint<Search,object>{public override void Configure(){Get("/search");}public override Task HandleAsync(Search r,CancellationToken ct){return Send.OkAsync(new {message="ok"});}}
class CreateEndpoint:Endpoint<Input>{public override void Configure(){Post("/items/{id}");}public override Task HandleAsync(Input r,CancellationToken ct){if(r.Id<0)return Send.NotFoundAsync();return Send.OkAsync(new Output{Count=1});}}
`},doc=>{
  expect(doc.paths['/search'].get.requestBody).toBeUndefined();
  expect(doc.paths['/search'].get.parameters.map((p:any)=>p.name)).toEqual(['id','nested.name']);
  expect(doc.paths['/search'].get.responses['200'].content['application/json'].schema.properties.message).toEqual({type:'string'});
  const op=doc.paths['/items/{id}'].post;expect(op.parameters[0].schema.type).toBe('integer');
  expect(op.responses['404']).toBeDefined();expect(op.responses['200'].content['application/json'].schema.$ref).toContain('Output');
  expect(doc.components.schemas.Input.properties.title.type).toBe('string');
  expect(doc.components.schemas.serialized_Output.properties.note.type).toEqual(['string','null']);
 });
});
it('resolves imported Fiber binding and specializes an interface response payload',async()=>{
 await fixture({
  'go.mod':'module example\n\ngo 1.22\nrequire github.com/gofiber/fiber/v3 v3.0.0',
  'models/book.go':'package models\ntype Book struct {Title string `json:"title"`}',
  'main.go':`package main
import ("github.com/gofiber/fiber/v3"; "example/models")
type Envelope struct {Data interface{} \`json:"data"\`}
func create(c fiber.Ctx)error{book:=new(models.Book);c.Bind().Body(book);return c.JSON(Envelope{Data:*book})}
func list(c fiber.Ctx)error{var books []models.Book;return c.JSON(Envelope{Data:books})}
func main(){app:=fiber.New();app.Post("/books",create);app.Get("/books",list)}`,
 },doc=>{
  const item={$ref:'#/components/schemas/Book'};
  expect(doc.paths['/books'].post.requestBody.content['application/json'].schema).toEqual({$ref:'#/components/schemas/input_Book'});
  expect(doc.paths['/books'].post.responses['200'].content['application/json'].schema.properties.data).toEqual(item);
  expect(doc.paths['/books'].get.responses['200'].content['application/json'].schema.properties.data).toEqual({type:['array','null'],items:item});
 });
});
it('keeps qualified Rocket mounts defined in a different module',async()=>{
 await fixture({
  'src/main.rs':`mod api; fn main(){rocket::build().mount("/v1",routes![api::get]);}`,
  'src/api.rs':`use rocket::get; #[get("/item")] fn get()->String{"ok".into()}`,
 },doc=>{expect(Object.keys(doc.paths)).toEqual(['/v1/item']);});
});
it('applies unconditional FastEndpoints rules only to request schemas',async()=>{
 await fixture({'Api.cs':`using FastEndpoints;using FluentValidation;
class Data {public string? Name {get;set;} public int Age {get;set;} public string[]? Tags {get;set;} public string? Conditional {get;set;} }
class Rules:Validator<Data>{public Rules(){RuleFor(x=>x.Name).NotEmpty();RuleFor(x=>x.Age).GreaterThan(10);RuleFor(x=>x.Tags).NotEmpty();RuleFor(x=>x.Conditional).NotEmpty().When(x=>x.Age>20);}}
class Api:Endpoint<Data,Data>{public override void Configure(){Post("/data");}public override Task HandleAsync(Data r,CancellationToken ct){return Send.OkAsync(r);}}`},doc=>{
 const op=doc.paths['/data'].post,body=op.requestBody.content['application/json'].schema;
 expect(body.properties.name).toEqual({type:'string',minLength:1});expect(body.properties.age.minimum).toBe(11);
 expect(body.properties.tags).toMatchObject({type:'array',minItems:1});expect(body.required).toContain('name');expect(body.required).not.toContain('conditional');
 expect(doc.components.schemas.Data.properties.name.type).toEqual(['string','null']);expect(doc.components.schemas.Data.properties.age.minimum).toBeUndefined();
 });
});
it('extracts returned Rocket json fields and registered catchers without using unrelated locals',async()=>{
 await fixture({'src/main.rs':`use rocket::serde::json::{Value,json};
#[get("/item")] fn item()->Option<Value>{let ignored=json!({"secret":"hidden"});Some(json!({"status":"ok","count":3}))}
#[catch(404)] fn missing()->Value{json!({"status":"error","reason":"missing"})}
fn main(){rocket::build().mount("/api",routes![item]).register("/api",catchers![missing]);}`},doc=>{
  const responses=doc.paths['/api/item'].get.responses;
  expect(responses['200'].content['application/json'].schema).toEqual({type:'object',properties:{status:{type:'string'},count:{type:'integer'}},required:['status','count']});
  expect(responses['404'].content['application/json'].schema.properties).toEqual({status:{type:'string'},reason:{type:'string'}});
 });
});
it('does not swallow the DTO following a modern semicolon-only C# class',async()=>{
 await fixture({'Api.cs':`using FastEndpoints;
namespace Example;
public partial class SerializerCtx : JsonSerializerContext;
public class Input {public string Name {get;set;}}
class Api:Endpoint<Input,Input>{public override void Configure(){Post("/new");}public override Task HandleAsync(Input r,CancellationToken ct){return Send.OkAsync(r);}}`},(doc,result)=>{
 expect(doc.paths['/new'].post.requestBody.content['application/json'].schema).toEqual({$ref:'#/components/schemas/Input'});
 expect(doc.components.schemas.Input.properties.name.type).toBe('string');expect(result.project.unresolved).toEqual([]);
 });
});

it('keeps validation opt-out, initialized defaults and conditional blocks conservative',async()=>{
 await fixture({'Api.cs':`using FastEndpoints;using FluentValidation;
class Data {public string? Name {get;set;} public string? Label {get;set;} = "default"; public string? Conditional {get;set;}}
class Rules:Validator<Data>{public Rules(){RuleFor(x=>x.Name).NotEmpty();RuleFor(x=>x.Label).NotEmpty();if(enabled){RuleFor(x=>x.Conditional).NotEmpty();}}}
class Active:Endpoint<Data>{public override void Configure(){Post("/active");}}
class Disabled:Endpoint<Data>{public override void Configure(){Post("/disabled");DontAutoValidate();}}`},doc=>{
 const active=doc.paths['/active'].post.requestBody.content['application/json'].schema;
 expect(active.required).toContain('name');expect(active.required).not.toContain('label');expect(active.required).not.toContain('conditional');
 expect(active.properties.label).toEqual({type:'string',minLength:1});
 expect(doc.paths['/disabled'].post.requestBody.content['application/json'].schema).toEqual({$ref:'#/components/schemas/Data'});
 expect(doc.components.schemas.Data.properties.name.type).toEqual(['string','null']);
 });
});
it('separates C# response presence, ignore conditions, nested references and path binding',async()=>{
 await fixture({'Api.cs':`using FastEndpoints;using System.Text.Json.Serialization;
class Data {public int Id {get;set;} public string? Name {get;set;}
[JsonIgnore] public string? Secret {get;set;}
[JsonIgnore(Condition=JsonIgnoreCondition.WhenWritingNull)] public string? Optional {get;set;}
public Data? Child {get;set;} }
class Api:Endpoint<Data,Data>{public override void Configure(){Post("/data/{id}");} public override Task HandleAsync(Data r,CancellationToken ct){return Send.OkAsync(r);}}`},doc=>{
 const op=doc.paths['/data/{id}'].post;
 const inputRequired=op.requestBody.content['application/json'].schema.required??[];
 expect(inputRequired).not.toContain('id');
 const output=doc.components.schemas.serialized_Data;
 expect(output.required).toEqual(['id','name','child']);
 expect(output.properties).not.toHaveProperty('secret');
 expect(output.properties.child.anyOf[0].$ref).toBe('#/components/schemas/serialized_Data');
 expect((doc.components.schemas.Data.required??[])).not.toContain('name');
 });
});
it('retains Fiber error statuses, unknown status and multiple payload branches',async()=>{
 await fixture({'main.go':`package main
import ("github.com/gofiber/fiber/v3"; "net/http")
type First struct {Name string}
type Second struct {Count int}
func handler(c fiber.Ctx)error{if down{return c.Status(http.StatusServiceUnavailable).JSON(First{})};if other{return c.Status(customCode).JSON(Second{})};if variant{return c.JSON(First{})};return c.JSON(Second{})}
func main(){app:=fiber.New();app.Get("/item",handler)}`},(doc,result)=>{
 const responses=doc.paths['/item'].get.responses;
 expect(Object.keys(responses).sort()).toEqual(['200','503','default']);
 expect(responses['200'].content['application/json'].schema.anyOf).toEqual([{$ref:'#/components/schemas/First'},{$ref:'#/components/schemas/Second'}]);
 expect(result.project.operations[0].gaps).toContain('response-unknown');
 });
});
it('infers Rocket scalar aliases through a typed mutex and does not guess custom len methods',async()=>{
 await fixture({'src/main.rs':`use rocket::serde::json::{Value,json}; type Values=Mutex<Vec<String>>;type Shared<'r>=&'r State<Values>;
struct Custom {}
#[get("/count")] fn count(values:Shared<'_>)->Value{let values=values.lock().await;let count=values.len();json!({"count":count})}
#[get("/custom")] fn custom(value:Custom)->Value{let count=value.len();json!({"count":count})}
fn main(){rocket::build().mount("/",routes![count,custom]);}`},doc=>{
 expect(doc.paths['/count'].get.responses['200'].content['application/json'].schema.properties.count).toEqual({type:'integer',format:'int64'});
 expect(doc.paths['/custom'].get.responses['200'].content['application/json'].schema.properties.count).toEqual({});
 });
});
it('narrows a directly constructed Some field but preserves alternative return branches',async()=>{
 await fixture({'src/main.rs':`use rocket::serde::json::Json;
struct Data{id:Option<i32>}
#[get("/some")]fn one()->Json<Data>{Json(Data{id:Some(1)})}
#[get("/branch")]fn two()->Json<Data>{if missing{return Json(Data{id:None});}Json(Data{id:Some(1)})}
fn main(){rocket::build().mount("/",routes![one,two]);}`},doc=>{
 expect(doc.paths['/some'].get.responses['200'].content['application/json'].schema.properties.id.type).toBe('integer');
 expect(doc.paths['/branch'].get.responses['200'].content['application/json'].schema.$ref).toBe('#/components/schemas/serialized_Data');
 expect(doc.components.schemas.serialized_Data.properties.id.type).toEqual(['integer','null']);
 });
});
it('does not fabricate an external embedded Go type as a JSON property',async()=>{
 await fixture({'main.go':`package main
import("github.com/gofiber/fiber/v3";"gorm.io/gorm")
type Book struct {gorm.Model;Title string}
func handler(c fiber.Ctx)error{return c.JSON(Book{})}
func main(){app:=fiber.New();app.Get("/book",handler)}`},(doc,result)=>{
 expect(doc.components.schemas.Book.properties).not.toHaveProperty('Model');
 expect(doc.components.schemas.Book['x-code-to-openapi-unresolved-embedded']).toEqual(['gorm.Model']);
 expect(result.project.operations[0].gaps).toContain('response-schema-unknown');
 });
});
