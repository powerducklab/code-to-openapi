import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('honors JsonSerializable keys and nullable private values without exposing private fields',async()=>{
 const root=await mkdtemp(join(tmpdir(),'php-json-'));
 try{
 await writeFile(join(root,'index.php'),`<?php
use Psr\Http\Message\ResponseInterface;
class User implements JsonSerializable {
 private ?int $id; private string $password; public string $unserialized;
 public function jsonSerialize(): array { return ['id'=>$this->id, 'kind'=>'user']; }
}
class Plain { public string $name; private string $secret; }
$app->get('/user',function($req,$res){return $res->withJson(new User());});
$app->get('/plain',function($req,$res){return $res->withJson(new Plain());});
`);
 // The dependency is authoritative even where the fixture does not bootstrap a server.
 await writeFile(join(root,'composer.json'),JSON.stringify({require:{'slim/slim':'^4'}}));
 const result=await scanProject({root});const converted=await result.convert();expect(converted.documentValid).toBe(true);
 const doc=converted.document as any;
 expect(doc.paths['/user'].get.responses['200'].content['application/json'].schema.$ref).toBe('#/components/schemas/output_User');
 expect(doc.components.schemas.output_User).toEqual({type:'object',properties:{id:{type:['integer','null']},kind:{type:'string'}},required:['id','kind']});
 expect(doc.components.schemas.output_Plain.properties).toEqual({name:{type:'string'}});
 }finally{await rm(root,{recursive:true,force:true});}
});

it('resolves same-named controllers by imports and follows an inherited invokable',async()=>{
 const root=await mkdtemp(join(tmpdir(),'php-namespaces-'));
 try{
 await writeFile(join(root,'composer.json'),JSON.stringify({require:{'slim/slim':'^4'}}));
 await writeFile(join(root,'one.php'),`<?php namespace One; class Payload { public string $first; } class Action { public function __invoke($req,$res){return $res->withJson(new Payload());} }`);
 await writeFile(join(root,'two.php'),`<?php namespace Two; class Payload { public int $second; } class Action { public function __invoke($req,$res){return $res->withJson(new Payload());} }`);
 await writeFile(join(root,'child.php'),`<?php namespace Child; use One\\Action as Base; class Handler extends Base {}`);
 await writeFile(join(root,'index.php'),`<?php use One\\Action as First; use Two\\Action as Second; use Child\\Handler; $app->get('/one',First::class); $app->get('/two',Second::class); $app->get('/child',Handler::class);`);
 const result=await scanProject({root}); const converted=await result.convert();expect(converted.documentValid).toBe(true);
 const doc=converted.document as any;
 const ref=(path:string)=>doc.paths[path].get.responses['200'].content?.['application/json'].schema.$ref;
 expect(ref('/one')).toBe('#/components/schemas/output_One.Payload');
 expect(ref('/two')).toBe('#/components/schemas/output_Two.Payload');
 expect(ref('/child')).toBe(ref('/one'));
 expect(doc.components.schemas['output_One.Payload'].properties).toEqual({first:{type:'string'}});
 expect(doc.components.schemas['output_Two.Payload'].properties).toEqual({second:{type:'integer'}});
 }finally{await rm(root,{recursive:true,force:true});}
});

it('serializes nested nullable DTOs, inherited fields, defaults and multi-property declarations separately from input',async()=>{
 const root=await mkdtemp(join(tmpdir(),'php-nested-output-'));
 try{
 await writeFile(join(root,'composer.json'),JSON.stringify({require:{'slim/slim':'^4'}}));
 await writeFile(join(root,'index.php'),`<?php
class Secret { public string $name='visible'; private string $password='hidden'; }
class ParentDto {public string $base='base';}
class Payload extends ParentDto {
 public string $first='first', $later;
 public static string $global='not serialized';
 public $dynamic;
 public function __construct(public ?Secret $child=null){}
}
interface Service {public function one(): ?Secret;}
$app->get('/nested',function($req,$res){return $res->withJson(new Payload());});
$app->get('/optional',function($req,$res) use ($service){return $res->withJson($service->one());});
class Handler {public function __invoke($req,$res){return $res->withJson($this->service->one());} protected Service $service;}
$app->get('/typed-optional',Handler::class);
`);
 const result=await scanProject({root}); const converted=await result.convert();expect(converted.documentValid).toBe(true);
 const doc=converted.document as any;
 const payload=doc.components.schemas.output_Payload;
 expect(Object.keys(payload.properties).sort()).toEqual(['base','child','dynamic','first','later']);
 expect(payload.required.sort()).toEqual(['base','child','dynamic','first']);
 expect(payload.properties.child).toEqual({anyOf:[{$ref:'#/components/schemas/output_Secret'},{type:'null'}]});
 expect(doc.components.schemas.output_Secret.properties).toEqual({name:{type:'string'}});
 expect(doc.paths['/typed-optional'].get.responses['200'].content['application/json'].schema).toEqual(payload.properties.child);
 }finally{await rm(root,{recursive:true,force:true});}
});
