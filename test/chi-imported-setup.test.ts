import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {scanProject} from '../src/index.js';
it('follows imported router setup parameters through repeated prefixed groups',async()=>{
 const root=await mkdtemp(join(tmpdir(),'chi-setup-'));
 try {
  await mkdir(join(root,'routes'));
  await writeFile(join(root,'go.mod'),'module example.local/api\ngo 1.22\nrequire github.com/go-chi/chi/v5 v5.0.0');
  await writeFile(join(root,'main.go'),`package main
import ("github.com/go-chi/chi/v5";"example.local/api/routes")
func main(){r:=chi.NewRouter();r.Route("/v1",func(r chi.Router){routes.Setup(1,r)});r.Route("/v2",func(r chi.Router){routes.Setup(2,r)})}
`);
  await writeFile(join(root,'routes','routes.go'),`package routes
import("github.com/go-chi/chi/v5";"net/http")
func Setup(version int,r chi.Router){r.Group(func(inner chi.Router){register(inner)})}
func register(router chi.Router){router.Get("/items",func(w http.ResponseWriter,r *http.Request){w.WriteHeader(204)})}
`);
  const result=await scanProject({root,frameworks:['chi']});
  expect(result.project.operations.map(op=>op.path).sort()).toEqual(['/v1/items','/v2/items']);
  expect(result.project.operations.every(op=>op.origin?.file==='routes/routes.go')).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});
