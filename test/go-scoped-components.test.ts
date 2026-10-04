import {expect,it} from 'vitest';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it.each(['nethttp','chi','gin','echo','fiber'])('keeps imported same-name Go models distinct in %s',async(framework)=>{
 const root=await mkdtemp(join(tmpdir(),'go-components-'));
 try{
  for(const dir of ['one','two'])await mkdir(join(root,dir));
  const packages:Record<string,string>={chi:'github.com/go-chi/chi/v5',gin:'github.com/gin-gonic/gin',echo:'github.com/labstack/echo/v4',fiber:'github.com/gofiber/fiber/v2'};
  await writeFile(join(root,'go.mod'),'module example\ngo 1.22'+(packages[framework]?'\nrequire '+packages[framework]+(framework==='chi'?' v5.0.0':framework==='echo'?' v4.0.0':framework==='fiber'?' v2.0.0':' v1.0.0'):''));
  await writeFile(join(root,'one','types.go'),`package one
type Item struct{ First string }
type Envelope struct{ Data Item }
`);
  await writeFile(join(root,'two','types.go'),`package two
type Item struct{ Second int }
type Envelope struct{ Data Item }
`);
  const config:Record<string,{signature:string;send:(value:string)=>string;setup:string;route:string}>={
   nethttp:{signature:'w http.ResponseWriter,r *http.Request',send:value=>`json.NewEncoder(w).Encode(${value})`,setup:'',route:'http.HandleFunc'},
   chi:{signature:'w http.ResponseWriter,r *http.Request',send:value=>`json.NewEncoder(w).Encode(${value})`,setup:'r:=chi.NewRouter();',route:'r.Get'},
   gin:{signature:'c *gin.Context',send:value=>`c.JSON(200,${value})`,setup:'r:=gin.New();',route:'r.GET'},
   echo:{signature:'c echo.Context',send:value=>`return c.JSON(200,${value})`,setup:'r:=echo.New();',route:'r.GET'},
   fiber:{signature:'c *fiber.Ctx',send:value=>`return c.JSON(${value})`,setup:'r:=fiber.New();',route:'r.Get'},
  };
  const c=config[framework]!;const result=['echo','fiber'].includes(framework)?' error':'';
  await writeFile(join(root,'main.go'),`package main
import(${['nethttp','chi'].includes(framework)?'"net/http";"encoding/json";':''}"example/one";other "example/two"${packages[framework]?';"'+packages[framework]+'"':''})
func first(${c.signature})${result}{${c.send('one.Envelope{}')}}
func second(${c.signature})${result}{${c.send('other.Envelope{}')}}
func main(){${c.setup}${c.route}("/one",first);${c.route}("/two",second)}
`);
 const doc=(await (await scanProject({root})).convert()).document as any;
 const resolve=(s:any):any=>s.$ref?resolve(doc.components.schemas[s.$ref.split('/').pop()]):s;
 const schema=(path:string)=>resolve(doc.paths[path].get.responses['200'].content['application/json'].schema);
 expect(Object.keys(resolve(schema('/one').properties.Data).properties)).toEqual(['First']);
 expect(Object.keys(resolve(schema('/two').properties.Data).properties)).toEqual(['Second']);
 }finally{await rm(root,{recursive:true,force:true});}
});
