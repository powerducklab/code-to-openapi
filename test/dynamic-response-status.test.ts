import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it.each(['gin','echo'])('does not invent a success status for dynamic %s responses',async(framework)=>{
 const root=await mkdtemp(join(tmpdir(),'status-go-'));
 try{
 const pkg=framework==='gin'?'github.com/gin-gonic/gin':'github.com/labstack/echo/v4';
 await writeFile(join(root,'go.mod'),`module example\ngo 1.22\nrequire ${pkg} ${framework==='gin'?'v1.9.1':'v4.0.0'}`);
 await writeFile(join(root,'main.go'),framework==='gin'?`package main
import "${pkg}"
func handle(c *gin.Context){status:=externalStatus();c.JSON(status,gin.H{"ok":true})}
func main(){r:=gin.New();r.GET("/dynamic",handle)}`:`package main
import "${pkg}"
func handle(c echo.Context)error{status:=externalStatus();return c.String(status,"hello")}
func main(){r:=echo.New();r.GET("/dynamic",handle)}`);
 const result=await scanProject({root});const doc=(await result.convert()).document as any;
 expect(Object.keys(doc.paths['/dynamic'].get.responses)).toEqual(['default']);
 expect(result.project.operations[0]?.gaps).toContain('response-unknown');
 }finally{await rm(root,{recursive:true,force:true});}
});
it('distinguishes omitted Slim status from an explicit dynamic status',async()=>{
 const root=await mkdtemp(join(tmpdir(),'status-php-'));
 try{
 await writeFile(join(root,'composer.json'),JSON.stringify({require:{'slim/slim':'^3.0'}}));
 await writeFile(join(root,'app.php'),`<?php
$app = new \\Slim\\App();
$app->get('/dynamic',function($request,$response){return $response->withJson(['ok'=>true],externalStatus());});
$app->get('/default',function($request,$response){return $response->withJson(['ok'=>true]);});
`);
 const result=await scanProject({root});const doc=(await result.convert()).document as any;
 expect(Object.keys(doc.paths['/dynamic'].get.responses)).toEqual(['default']);
 expect(Object.keys(doc.paths['/default'].get.responses)).toEqual(['200']);
 }finally{await rm(root,{recursive:true,force:true});}
});
it('retains Slim same-status branches without collecting uncalled nested functions',async()=>{
 const root=await mkdtemp(join(tmpdir(),'status-php-branches-'));
 try{
 await writeFile(join(root,'composer.json'),JSON.stringify({require:{'slim/slim':'^3.0'}}));
 await writeFile(join(root,'app.php'),`<?php
$app=new \\Slim\\App();
$app->get('/branches',function($request,$response){
 $unused=function() use($response){return $response->withJson(['wrong'=>true],201);};
 if($request->getQueryParam('branch'))return $response->withJson(['first'=>true]);
 return $response->withJson(['second'=>'value']);
});`);
 const doc=(await (await scanProject({root})).convert()).document as any;
 const responses=doc.paths['/branches'].get.responses;
 expect(Object.keys(responses)).toEqual(['200']);
 const shapes=responses['200'].content['application/json'].schema.anyOf;
 expect(shapes).toHaveLength(2);
 expect(shapes.map((s:any)=>Object.keys(s.properties)[0]).sort()).toEqual(['first','second']);
 }finally{await rm(root,{recursive:true,force:true});}
});
it.each(['laravel','symfony'])('does not invent 200 for an explicit dynamic %s JSON status',async(framework)=>{
 const root=await mkdtemp(join(tmpdir(),'status-json-'));
 try{
 await writeFile(join(root,'composer.json'),JSON.stringify({require:{[framework==='laravel'?'laravel/framework':'symfony/framework-bundle']:'*'}}));
 await writeFile(join(root,'app.php'),framework==='laravel'?`<?php use Illuminate\\Support\\Facades\\Route;
Route::get('/dynamic',function(){return response()->json(['ok'=>true],externalStatus());});
Route::get('/default',function(){return response()->json(['ok'=>true]);});
`:`<?php use Symfony\\Component\\Routing\\Attribute\\Route;use Symfony\\Component\\HttpFoundation\\JsonResponse;
class Api {#[Route('/dynamic',methods:['GET'])]public function dynamic(){return new JsonResponse(['ok'=>true],externalStatus());}
#[Route('/default',methods:['GET'])]public function omitted(){return new JsonResponse(['ok'=>true]);}}`);
 const result=await scanProject({root});const doc=(await result.convert()).document as any;
 expect(Object.keys(doc.paths['/dynamic'].get.responses)).toEqual(['default']);
 expect(Object.keys(doc.paths['/default'].get.responses)).toEqual(['200']);
 expect(result.project.operations.find(o=>(o.fullPath??o.path)==='/dynamic')?.gaps).toContain('response-unknown');
 }finally{await rm(root,{recursive:true,force:true});}
});
it('uses Laravel factory signatures for downloads, streams and no-content responses',async()=>{
 const root=await mkdtemp(join(tmpdir(),'status-laravel-factory-'));
 try{
 await writeFile(join(root,'composer.json'),JSON.stringify({require:{'laravel/framework':'*'}}));
 await writeFile(join(root,'app.php'),`<?php use Illuminate\\Support\\Facades\\Route;
Route::get('/download',function(){return response()->download('/tmp/report','report.csv',['X-Test'=>'yes']);});
Route::get('/sse-download',function(){return response()->streamDownload(function(){echo 'event';},'events.txt',['Content-Type'=>'text/event-stream']);});
Route::get('/stream',function(){return response()->stream(function(){echo 'event';},externalStatus());});
Route::get('/empty',function(){return response()->noContent(externalStatus());});
`);
 const doc=(await (await scanProject({root})).convert()).document as any;
 for(const path of ['/download','/sse-download'])expect(Object.keys(doc.paths[path].get.responses)).toEqual(['200']);
 for(const path of ['/stream','/empty'])expect(Object.keys(doc.paths[path].get.responses)).toEqual(['default']);
 }finally{await rm(root,{recursive:true,force:true});}
});
it('preserves Fiber status setters for text and file responses and SendStatus',async()=>{
 const root=await mkdtemp(join(tmpdir(),'fiber-status-chain-'));
 try{
 await writeFile(join(root,'go.mod'),'module example\ngo 1.22\nrequire github.com/gofiber/fiber/v2 v2.0.0');
 await writeFile(join(root,'main.go'),`package main
import "github.com/gofiber/fiber/v2"
func text(c *fiber.Ctx)error{return c.Status(400).SendString("bad")}
func file(c *fiber.Ctx)error{return c.Status(206).SendFile("file.txt")}
func status(c *fiber.Ctx)error{return c.SendStatus(404)}
func dynamic(c *fiber.Ctx)error{return c.Status(externalStatus()).SendString("dynamic")}
func main(){e:=fiber.New();e.Get("/text",text);e.Get("/file",file);e.Get("/status",status);e.Get("/dynamic",dynamic)}`);
 const doc=(await (await scanProject({root})).convert()).document as any;
 for(const [path,status] of [['/text','400'],['/file','206'],['/status','404'],['/dynamic','default']])expect(Object.keys(doc.paths[path].get.responses)).toEqual([status]);
 }finally{await rm(root,{recursive:true,force:true});}
});
