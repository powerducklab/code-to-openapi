import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it.each(['nethttp','chi'])('retains same-status JSON branches for %s',async(framework)=>{
 const root=await mkdtemp(join(tmpdir(),'go-variants-'));
 try{
  await writeFile(join(root,'go.mod'),'module example\ngo 1.22\nrequire github.com/go-chi/chi/v5 v5.0.0');
  await writeFile(join(root,'main.go'),`package main
import("net/http";"encoding/json"${framework==='chi'?';"github.com/go-chi/chi/v5"':''})
func handle(w http.ResponseWriter,r *http.Request){if r.URL.Query().Get("shape")=="one"{json.NewEncoder(w).Encode(map[string]string{"first":"value"});return};json.NewEncoder(w).Encode(map[string]int{"second":42})}
func main(){${framework==='chi'?'r:=chi.NewRouter();r.Get("/variants",handle)':'http.HandleFunc("/variants",handle)'}}`);
 const doc=(await (await scanProject({root})).convert()).document as any;
 const variants=doc.paths['/variants'].get.responses['200'].content['application/json'].schema.anyOf;
 expect(variants).toHaveLength(2);
 expect(variants.map((s:any)=>Object.keys(s.properties)[0]).sort()).toEqual(['first','second']);
 }finally{await rm(root,{recursive:true,force:true});}
});
it.each(['echo','fiber'])('preserves %s JSON and text media for one status',async(framework)=>{
 const root=await mkdtemp(join(tmpdir(),'go-media-'));
 try{
 const pkg=framework==='echo'?'github.com/labstack/echo/v4':'github.com/gofiber/fiber/v2';
 await writeFile(join(root,'go.mod'),`module example\ngo 1.22\nrequire ${pkg} ${framework==='echo'?'v4.0.0':'v2.0.0'}`);
 await writeFile(join(root,'main.go'),framework==='echo'?`package main
import "${pkg}"
func handler(c echo.Context)error{if c.QueryParam("text")!=""{return c.String(200,"text")};return c.JSON(200,map[string]string{"value":"json"})}
func main(){e:=echo.New();e.GET("/mixed",handler)}`:`package main
import "${pkg}"
func handler(c *fiber.Ctx)error{if c.Query("text")!=""{return c.SendString("text")};return c.JSON(map[string]string{"value":"json"})}
func main(){e:=fiber.New();e.Get("/mixed",handler)}`);
 const doc=(await (await scanProject({root})).convert()).document as any;
 expect(Object.keys(doc.paths['/mixed'].get.responses['200'].content).sort()).toEqual(['application/json','text/plain']);
 }finally{await rm(root,{recursive:true,force:true});}
});
