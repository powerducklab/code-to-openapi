import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('follows inherited action dispatch, typed services and source-defined JSON wrappers',async()=>{
 const root=await mkdtemp(join(tmpdir(),'slim-action-'));
 try{
  await writeFile(join(root,'composer.json'),JSON.stringify({require:{'slim/slim':'^4'}}));
  await writeFile(join(root,'app.php'),`<?php
class User implements \\JsonSerializable {
 private string $id;
 public function jsonSerialize():array {return ['id'=>$this->id];}
}
interface Service { public function one(): User; }
class Envelope implements \\JsonSerializable {
 private int $code; private User $result;
 public function __construct(int $code,User $result){$this->code=$code;$this->result=$result;}
 public function status():int{return $this->code;}
 public function jsonSerialize():array{return ['code'=>$this->code,'result'=>$this->result];}
}
abstract class Base {
 protected Service $service;
 public function __invoke($request,$response,$args){$this->reply=$response;return $this->perform();}
 protected function output($data,int $code=201){$payload=new Envelope($code,$data);return $this->encode($payload);}
 protected function encode(Envelope $payload){$json=json_encode($payload);$this->reply->getBody()->write($json);return $this->reply->withHeader('Content-Type','application/json')->withStatus($payload->status());}
}
class Action extends Base {protected function perform(){$user=$this->service->one();return $this->output($user);}}
class Cyclic extends Base {protected function perform(){return $this->perform();}}
$app->get('/user',Action::class);
$app->get('/cycle',Cyclic::class);
`);
  const result=await scanProject({root});const converted=await result.convert();expect(converted.documentValid).toBe(true);
  const doc=converted.document as any;
  const schema=doc.paths['/user'].get.responses['201'].content['application/json'].schema;
  expect(schema.properties.code).toEqual({type:'integer'});
  expect(schema.properties.result).toEqual({$ref:'#/components/schemas/output_User'});
  expect(doc.components.schemas.output_User.properties.id).toEqual({type:'string'});
  expect(result.project.operations.find(operation=>operation.path==='/cycle')?.gaps).toContain('response-unknown');
 }finally{await rm(root,{recursive:true,force:true});}
});
it('does not invent success responses across finally, loose comparisons, or skipped elseif branches',async()=>{
 const root=await mkdtemp(join(tmpdir(),'slim-flow-boundaries-'));
 try{
  await writeFile(join(root,'composer.json'),JSON.stringify({require:{'slim/slim':'^4'}}));
  await writeFile(join(root,'app.php'),`<?php
class Branches { public function __invoke($request,$response,$args){
 if(false){return $response->withStatus(201);}
 elseif(false){return $response->withStatus(202);}
 else{return $response->withStatus(203);}
 return $response->withStatus(204);
}}
class FinalOverride { public function __invoke($request,$response,$args){
 try{return $response->withStatus(201);} finally{return $response->withStatus(202);}
}}
class Loose {public function __invoke($request,$response,$args){
 if(0 == null){return $response->withStatus(201);}else{return $response->withStatus(202);}
}}
$app->get('/branches',Branches::class);
$app->get('/finally',FinalOverride::class);
$app->get('/loose',Loose::class);
`);
  const result=await scanProject({root});
  expect(result.project.operations.find(op=>op.path==='/branches')?.responses.map(r=>r.statusCode)).toEqual(['203']);
  for(const path of ['/finally','/loose'])expect(result.project.operations.find(op=>op.path===path)?.gaps).toContain('response-unknown');
 }finally{await rm(root,{recursive:true,force:true});}
});
