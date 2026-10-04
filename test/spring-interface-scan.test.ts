import { it, expect } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProject } from '../src/index.js';

it('inherits interface mappings and parameter annotations without emitting unmapped overloads', async () => {
 const root = await mkdtemp(join(tmpdir(), 'spring-interface-'));
 try {
  await writeFile(join(root,'Api.java'), `import org.springframework.web.bind.annotation.*;
@RequestMapping(value=Api.BASE)
interface Api {
 String BASE = "/api";
 String PATH = "/pets/{id}";
 @ApiResponse(responseCode="404", content=@Content(mediaType="application/json", schema=@Schema(implementation=Pet.class)))
 @GetMapping(value=Api.PATH) Pet get(@Min(value=0) @PathVariable("id") Long id, @RequestParam(value="verbose", required=false) Boolean verbose);
 @PostMapping("/pets") Pet create(@RequestBody Pet pet);
}
class Pet {
 private Long id;
 public String name;
 public java.net.URI uri;
 public java.util.List<@Valid Role> roles;
 @Min(value=0L) @Schema(accessMode=Schema.AccessMode.READ_ONLY, requiredMode=Schema.RequiredMode.REQUIRED, description="static value")
 public Long getId() { return id; }
}
class Role { public String title; }
`);
  await writeFile(join(root,'Controller.java'), `import org.springframework.web.bind.annotation.*;
@RestController
class Controller implements Api {
 public Pet get(Long renamed, Boolean verbose) { return null; }
 public Pet get(String name) { return null; }
 public Pet create(Pet renamed) { return null; }
}`);
  const result = await scanProject({root});
  const converted = await result.convert();
  expect(converted.documentValid).toBe(true);
  expect(result.project.operations).toHaveLength(2);
  const get:any = converted.document.paths['/api/pets/{id}'].get;
  expect(get.parameters).toEqual(expect.arrayContaining([
   expect.objectContaining({name:'id',in:'path',required:true,schema:expect.objectContaining({type:'integer'})}),
   expect.objectContaining({name:'verbose',in:'query',schema:expect.objectContaining({type:'boolean'})}),
  ]));
  expect(get.parameters.find((p:any)=>p.name==='verbose').required).not.toBe(true);
  const pet:any = converted.document.components?.schemas?.Pet;
  expect(pet.properties).toMatchObject({id:{type:'integer',minimum:0,readOnly:true},name:{type:'string'},uri:{type:'string',format:'uri'},roles:{type:'array',items:{$ref:'#/components/schemas/Role'}}});
  expect(pet.required).toContain('id');
  expect(get.parameters.find((p:any)=>p.name==='id').schema.minimum).toBe(0);
  expect(get.responses['404'].content['application/json'].schema.$ref).toBe('#/components/schemas/Pet');
  expect(converted.document.paths['/api/pets'].post.requestBody.content['application/json'].schema).toMatchObject({$ref:'#/components/schemas/Pet'});
  expect(result.project.unresolved).toHaveLength(0);
 } finally { await rm(root,{recursive:true,force:true}); }
});

it('includes ignored generated Java only with an explicit in-project source root', async () => {
 const root=await mkdtemp(join(tmpdir(),'spring-generated-'));
 try {
  await mkdir(join(root,'target/generated-sources/api'),{recursive:true});
  await writeFile(join(root,'.gitignore'),'target/');
  await writeFile(join(root,'pom.xml'),'<project/>');
  await writeFile(join(root,'Controller.java'),'import org.springframework.web.bind.annotation.*; @RestController class Controller implements Api { public String ping() { return "ok"; } }');
  await writeFile(join(root,'target/generated-sources/api/Api.java'),'import org.springframework.web.bind.annotation.*; interface Api { @GetMapping("/ping") String ping(); }');
  const missing=await scanProject({root});
  expect(missing.project.operations).toHaveLength(0);
  expect(missing.project.unresolved.length).toBeGreaterThan(0);
  const present=await scanProject({root,additionalSourceRoots:['target/generated-sources/api']});
  expect(present.project.operations.map(o=>o.path)).toEqual(['/ping']);
  expect(present.project.unresolved).toHaveLength(0);
  const ignored=await scanProject({root,additionalSourceRoots:['target/generated-sources/api'],ignore:['target/**']});
  expect(ignored.project.operations).toHaveLength(0);
  await writeFile(join(root,'.powerduckignore'),'target/**');
  const privateSources=await scanProject({root,additionalSourceRoots:['target/generated-sources/api']});
  expect(privateSources.project.operations).toHaveLength(0);
  await expect(scanProject({root,additionalSourceRoots:['..']})).rejects.toThrow('subdirectory');
 } finally {await rm(root,{recursive:true,force:true});}
});
