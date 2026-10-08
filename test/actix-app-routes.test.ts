import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {scanProject} from '../src/index.js';
it('extracts App.route bindings and selects the qualified handler module',async()=>{
 const root=await mkdtemp(join(tmpdir(),'actix-app-'));
 try {
  await mkdir(join(root,'src'));
  await writeFile(join(root,'Cargo.toml'),'[package]\nname="api"\nversion="0.1.0"\n[dependencies]\nactix-web="4"\n');
  await writeFile(join(root,'src/main.rs'),`use actix_web::{web,App};
mod users; mod books;
fn main(){App::new().route("/users",web::post().to(users::create)).route("/books",web::post().to(books::create));}
`);
  await writeFile(join(root,'src/users.rs'),`use actix_web::{web,HttpResponse};
struct UserInput { name: String }
async fn create(body:web::Json<UserInput>)->HttpResponse {HttpResponse::NoContent().finish()}
`);
  await writeFile(join(root,'src/books.rs'),`use actix_web::{web,HttpResponse};
struct BookInput { title: String }
async fn create(body:web::Json<BookInput>)->HttpResponse {HttpResponse::NoContent().finish()}
`);
  const result=await scanProject({root,frameworks:['actix']});
  expect(result.project.operations).toHaveLength(2);
  for(const [path,model] of [['/users','UserInput'],['/books','BookInput']]){
   const op=result.project.operations.find(op=>op.path===path)!;
   expect(op.requestBody?.content?.[0]?.schema).toEqual({$ref:`#/components/schemas/${model}`});
   expect(op.responses[0]?.statusCode).toBe('204');
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
