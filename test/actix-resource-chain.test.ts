import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProject } from '../src/index.js';
it('keeps resource routes through app_data and derives echoed Json extractor response',async()=>{
 const root=await mkdtemp(join(tmpdir(),'actix-chain-'));
 try {
  await mkdir(join(root,'src'));
  await writeFile(join(root,'Cargo.toml'),'[package]\nname="example"\nversion="0.1.0"\n[dependencies]\nactix-web="4"');
  await writeFile(join(root,'src/main.rs'),`use actix_web::{web,App,HttpResponse};
struct Payload { name: String, number: i32 }
async fn handler(item:web::Json<Payload>)->HttpResponse {HttpResponse::Ok().json(item.0)}
fn main(){App::new().service(web::resource("/payload").app_data(web::JsonConfig::default().limit(1024)).route(web::post().to(handler)).route(web::put().to(handler)));}`);
  const r=await scanProject({root});const c=await r.convert();
  expect(r.project.operations.map(o=>o.method).sort()).toEqual(['post','put']);
  for(const method of ['post','put']){
   const op=c.document.paths['/payload'][method];
   expect(op.responses['200'].content['application/json'].schema).toEqual(op.requestBody.content['application/json'].schema);
  }
  expect(c.document.components.schemas.Payload.properties).toMatchObject({name:{type:'string'},number:{type:'integer'}});
 } finally {await rm(root,{recursive:true,force:true});}
});
