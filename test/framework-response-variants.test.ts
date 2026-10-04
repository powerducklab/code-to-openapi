import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it.each(['express','laravel','symfony'])('preserves differing same-status %s JSON bodies',async(framework)=>{
 const root=await mkdtemp(join(tmpdir(),'response-shapes-'));
 try{
 if(framework==='express'){
  await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{express:'*'}}));
  await writeFile(join(root,'app.js'),`const express=require('express');const app=express();app.get('/variants',(req,res)=>{if(req.query.first)return res.json({first:'value'});return res.json({second:42});});`);
 }else if(framework==='laravel'){
  await writeFile(join(root,'composer.json'),JSON.stringify({require:{'laravel/framework':'^11.0'}}));
  await writeFile(join(root,'web.php'),`<?php use Illuminate\\Support\\Facades\\Route;
Route::get('/variants',function(){if(random_int(0,1))return response()->json(['first'=>'value']);return response()->json(['second'=>42]);});`);
 }else{
  await writeFile(join(root,'composer.json'),JSON.stringify({require:{'symfony/framework-bundle':'^6.0'}}));
  await writeFile(join(root,'Controller.php'),`<?php use Symfony\\Component\\Routing\\Attribute\\Route;use Symfony\\Component\\HttpFoundation\\JsonResponse;
class Controller{#[Route('/variants',methods:['GET'])]public function show(){if(random_int(0,1))return new JsonResponse(['first'=>'value']);return new JsonResponse(['second'=>42]);}}`);
 }
 const result=await scanProject({root});const doc=(await result.convert()).document as any;
 const shapes=doc.paths['/variants'].get.responses['200'].content['application/json'].schema.anyOf;
 expect(shapes).toHaveLength(2);
 expect(shapes.map((s:any)=>Object.keys(s.properties)[0]).sort()).toEqual(['first','second']);
 }finally{await rm(root,{recursive:true,force:true});}
});
it('retains both Actix response structs at the same status',async()=>{
 const root=await mkdtemp(join(tmpdir(),'actix-response-shapes-'));
 try{
  await writeFile(join(root,'Cargo.toml'),'[package]\nname="response-test"\nversion="0.1.0"\nedition="2021"\n[dependencies]\nactix-web="4"\nserde={version="1",features=["derive"]}');
  await writeFile(join(root,'main.rs'),`use actix_web::{get,App,HttpResponse};use serde::Serialize;
#[derive(Serialize)]struct First{first:String}
#[derive(Serialize)]struct Second{second:i32}
#[get("/variants")]async fn variants()->HttpResponse{
 if std::env::var("VARIANT").is_ok(){return HttpResponse::Ok().json(First{first:"value".to_owned()});}
 HttpResponse::Ok().json(Second{second:42})
}
fn main(){let _app=App::new().service(variants);}`);
  const doc=(await (await scanProject({root})).convert()).document as any;
  const shapes=doc.paths['/variants'].get.responses['200'].content['application/json'].schema.anyOf;
  expect(shapes).toHaveLength(2);
  expect(shapes.map((s:any)=>s.$ref.split('/').pop()).sort()).toEqual(['First','Second']);
 }finally{await rm(root,{recursive:true,force:true});}
});
it('preserves repeated ASP.NET response annotations for the same status',async()=>{
 const root=await mkdtemp(join(tmpdir(),'aspnet-response-shapes-'));
 try{
  await writeFile(join(root,'api.csproj'),'<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
  await writeFile(join(root,'Api.cs'),`using Microsoft.AspNetCore.Mvc;
public class First {public string Name {get;set;}}
public class Second {public int Count {get;set;}}
[ApiController][Route("variants")]public class ApiController:ControllerBase{
[HttpGet][ProducesResponseType(typeof(First),200)][ProducesResponseType(typeof(Second),200)]
public IActionResult Get(){return Ok(new First());}
}`);
  const doc=(await (await scanProject({root})).convert()).document as any;
  const shapes=doc.paths['/variants'].get.responses['200'].content['application/json'].schema.anyOf;
  expect(shapes).toHaveLength(2);
  expect(shapes.map((s:any)=>Object.keys(doc.components.schemas[s.$ref.split('/').pop()].properties)[0]).sort()).toEqual(['count','name']);
 }finally{await rm(root,{recursive:true,force:true});}
});
it.each(['laravel','symfony'])('does not treat unused nested %s closures as handler returns',async(framework)=>{
 const root=await mkdtemp(join(tmpdir(),'php-unused-closure-'));
 try{
 await writeFile(join(root,'composer.json'),JSON.stringify({require:{[framework==='laravel'?'laravel/framework':'symfony/framework-bundle']:'*'}}));
 await writeFile(join(root,'app.php'),framework==='laravel'?`<?php use Illuminate\\Support\\Facades\\Route;
Route::get('/actual',function(){$unused=function(){return response()->json(['notActual'=>true],201);};return response()->json(['actual'=>true]);});`:`<?php use Symfony\\Component\\Routing\\Attribute\\Route;use Symfony\\Component\\HttpFoundation\\JsonResponse;
class Api{#[Route('/actual',methods:['GET'])]public function actual(){$unused=function(){return new JsonResponse(['notActual'=>true],201);};return new JsonResponse(['actual'=>true]);}}`);
 const doc=(await (await scanProject({root})).convert()).document as any;
 expect(Object.keys(doc.paths['/actual'].get.responses)).toEqual(['200']);
 expect(Object.keys(doc.paths['/actual'].get.responses['200'].content['application/json'].schema.properties)).toEqual(['actual']);
 }finally{await rm(root,{recursive:true,force:true});}
});
