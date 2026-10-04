import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('resolves nested request types and respects JSON visibility in serialized outputs',async()=>{
 const root=await mkdtemp(join(tmpdir(),'aspnet-scoped-'));
 try{
 await writeFile(join(root,'App.csproj'),'<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>');
 await writeFile(join(root,'Users.cs'),`using Microsoft.AspNetCore.Mvc;using System.Text.Json.Serialization;using Mediator;namespace Example.Users;
 public class Create {public record UserData(string Email);public record Command(UserData User):IRequest<UserEnvelope>;}
 public record UserEnvelope(User User);
 public class User{public string? Email{get;set;}[JsonIgnore]public string Password{get;set;}[JsonIgnore(Condition=JsonIgnoreCondition.WhenWritingNull)]public string? Bio{get;set;}}
 [Route("users")]public class UsersController(IMediator mediator){[HttpPost]public async Task<ObjectResult> Create([FromBody]Create.Command command)=>new(await mediator.Send(command)){StatusCode=StatusCodes.Status201Created};}`);
 await writeFile(join(root,'Articles.cs'),`using Microsoft.AspNetCore.Mvc;namespace Example.Articles;
 public class Create{public record UserData(string Title);public record Command(UserData Article);}
 [Route("articles")]public class ArticlesController{[HttpPost]public string Post([FromBody]Create.Command command)=>"ok";}`);
 const result=await scanProject({root});const converted=await result.convert();expect(converted.documentValid).toBe(true);const doc=converted.document as any;
 const input=doc.paths['/users'].post.requestBody.content['application/json'].schema;
 expect(input.$ref).toBe('#/components/schemas/Example.Users.Create.Command');
 expect(doc.components.schemas['Example.Users.Create.UserData'].properties).toHaveProperty('email');
 expect(doc.components.schemas['Example.Users.Create.UserData'].properties).not.toHaveProperty('title');
 expect(doc.components.schemas['Example.Articles.Create.UserData'].properties).toHaveProperty('title');
 expect(doc.paths['/users'].post.responses['201']).toBeDefined();
 const user=doc.components.schemas.serialized_User;
 expect(user.properties).not.toHaveProperty('password');expect(user.required).toContain('email');expect(user.required).not.toContain('bio');
 expect(user.properties.bio).toEqual({type:'string'});
 }finally{await rm(root,{recursive:true,force:true});}
});

it('uses native System.Text.Json enum output defaults and declared string converters',async()=>{
 const root=await mkdtemp(join(tmpdir(),'aspnet-enums-'));
 try{
  await writeFile(join(root,'App.csproj'),'<Project Sdk="Microsoft.NET.Sdk.Web"/>');
  await writeFile(join(root,'Enums.cs'),`using Microsoft.AspNetCore.Mvc;using System.Text.Json.Serialization;
   enum State{None=0,Ready=5}
   [JsonConverter(typeof(JsonStringEnumConverter))]enum Named{One,Two}
   [JsonConverter(typeof(CustomConverter))]enum Custom{One,Two}
   public record Payload(State State,Named Named,Custom Custom);
   [Route("enums")]class EnumsController:ControllerBase{[HttpGet]public Payload Get()=>new(State.Ready,Named.One,Custom.One);}`);
  const doc=(await (await scanProject({root})).convert()).document as any;
  expect(doc.components.schemas.serialized_State).toEqual({type:'integer'});
  expect(doc.components.schemas.serialized_Named).toEqual({anyOf:[{type:'string',enum:['One','Two']},{type:'integer'}]});
  expect(doc.components.schemas.serialized_Custom.type).toBeUndefined();
  expect(doc.components.schemas.serialized_Custom.description).toContain('runtime');
 }finally{await rm(root,{recursive:true,force:true});}
});

it('recognizes awaited MVC no-content actions without reading nested local returns',async()=>{
 const root=await mkdtemp(join(tmpdir(),'aspnet-no-content-'));
 try{
  await writeFile(join(root,'App.csproj'),'<Project Sdk="Microsoft.NET.Sdk.Web"/>');
  await writeFile(join(root,'Actions.cs'),`using Microsoft.AspNetCore.Mvc;
   [Route("items")]class ItemsController:ControllerBase {
    [HttpDelete("{id}")]public async ValueTask<IActionResult> Delete(int id,[FromServices]int injected){await DeleteItem(id);return NoContent();}
    [HttpPost("reset")]public IActionResult Reset()=>NoContent();
    [HttpGet]public IActionResult Read(){IActionResult Helper()=>NoContent();return Ok(new {value=1});}
   }
   [Route("custom")]class CustomController:ControllerBase {
    public new IActionResult NoContent()=>Ok(new {value=1});
    [HttpDelete]public IActionResult Delete()=>NoContent();
   }`);
  const result=await scanProject({root});const doc=(await result.convert()).document as any;
  expect(doc.paths['/items/{id}'].delete.responses['204']).toBeDefined();
  expect(doc.paths['/items/{id}'].delete.parameters).toContainEqual(expect.objectContaining({in:'path',name:'id',schema:{type:'integer',format:'int32'}}));
  expect(doc.paths['/items/{id}'].delete.parameters.some((p:any)=>p.name==='injected')).toBe(false);
  expect(doc.paths['/items/reset'].post.responses['204']).toBeDefined();
  expect(doc.paths['/items'].get.responses['204']).toBeUndefined();
  expect(doc.paths['/custom'].delete.responses['204']).toBeUndefined();
 }finally{await rm(root,{recursive:true,force:true});}
});

it('merges multipart file parameters and preserves aliases, collections and optionality',async()=>{
 const root=await mkdtemp(join(tmpdir(),'aspnet-multipart-'));
 try{
  await writeFile(join(root,'App.csproj'),'<Project Sdk="Microsoft.NET.Sdk.Web"/>');
  await writeFile(join(root,'Uploads.cs'),`using Microsoft.AspNetCore.Mvc;using Microsoft.AspNetCore.Http;
   [ApiController][Route("uploads")]class UploadsController:ControllerBase {
    [HttpPost]public IActionResult Upload([FromForm(Name="avatar")]IFormFile photo,IFormFile? preview,IFormFileCollection attachments)=>NoContent();
    [HttpPost("optional")]public IActionResult Optional(IFormFile? photo)=>NoContent();
    [HttpPost("fields")]public IActionResult Fields(IFormCollection fields,IFormFile? photo)=>NoContent();
   }`);
  const doc=(await (await scanProject({root})).convert()).document as any;
  const body=doc.paths['/uploads'].post.requestBody;
  const schema=body.content['multipart/form-data'].schema;
  expect(body.required).toBe(true);
  expect(Object.keys(schema.properties).sort()).toEqual(['attachments','avatar','preview']);
  expect(schema.properties.attachments).toEqual({type:'array',items:{type:'string',format:'binary'}});
  expect(schema.required.sort()).toEqual(['avatar']);
  const optional=doc.paths['/uploads/optional'].post.requestBody;
  expect(optional.required??false).toBe(false);
  expect(optional.content['multipart/form-data'].schema.required??[]).toEqual([]);
  const fields=doc.paths['/uploads/fields'].post.requestBody.content['multipart/form-data'].schema;
  expect(fields.additionalProperties).toEqual({});
  expect(fields.properties.photo).toEqual({type:'string',format:'binary'});
  expect(fields.properties.files).toBeUndefined();
 }finally{await rm(root,{recursive:true,force:true});}
});
