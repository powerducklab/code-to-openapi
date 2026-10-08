import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {scanProject} from '../src/index.js';
it('keeps module-owned same-name routers separate and composes nested path extractors',async()=>{
 const root=await mkdtemp(join(tmpdir(),'axum-mount-'));
 try{
  await mkdir(join(root,'src'));
  await writeFile(join(root,'Cargo.toml'),'[package]\nname="mounts"\nversion="0.1.0"\n[dependencies]\naxum="0.8"');
  await writeFile(join(root,'src/main.rs'),`use axum::Router;mod users;mod books;
fn app()->Router { Router::new().nest("/{version}/users",users::routes()).nest("/{version}/books",books::routes()) }`);
  for(const [name,field]of [['users','email'],['books','title']]) await writeFile(join(root,'src',name+'.rs'),`use axum::{Router,Json,extract::Path,routing::get};
#[derive(Serialize)]struct ${name}ResultBody{${field}:String}
pub fn routes()->Router{Router::new().route("/{id}",get(show))}
async fn show(Path((_version,_id)):Path<(String,u64)>)->Json<${name}ResultBody>{todo!()}`);
  const result=await scanProject({root});const c=await result.convert();
  expect(c.documentValid).toBe(true);
  const d=c.document as any;
  expect(Object.keys(d.paths).sort()).toEqual(['/{version}/books/{id}','/{version}/users/{id}']);
  for(const path of Object.keys(d.paths)) {
   expect(d.paths[path].get.parameters.map((p:any)=>p.name).sort()).toEqual(['id','version']);
   const ref=d.paths[path].get.responses['200'].content['application/json'].schema.$ref;
   expect(Object.keys(d.components.schemas[ref.split('/').at(-1)].properties)).toEqual([path.includes('/users/')?'email':'title']);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
