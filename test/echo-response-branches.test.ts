import {it,expect} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {scanProject} from '../src/index.js';
it('preserves Echo same-status JSON alternatives, null and unknown status',async()=>{
 const root=await mkdtemp(join(tmpdir(),'echo-branches-'));
 try{
 await writeFile(join(root,'main.go'),`package main
import "github.com/labstack/echo/v4"
func item(c echo.Context) error {if c.QueryParam("a")=="1" {return c.JSON(200,map[string]any{"name":"ok"})};return c.JSON(200,nil)}
func dynamic(c echo.Context) error {code:=customStatus();return c.JSON(code,map[string]any{"ok":true})}
func main(){e:=echo.New();e.GET("/item",item);e.GET("/dynamic",dynamic)}`);
 const result=await scanProject({root});const converted=await result.convert();
 expect(converted.documentValid).toBe(true);
 const doc=converted.document as any;
 expect(doc.paths['/item'].get.responses['200'].content['application/json'].schema.anyOf).toEqual([{type:'object',properties:{name:{type:'string'}},required:['name']},{type:'null'}]);
 expect(doc.paths['/dynamic'].get.responses.default).toBeDefined();
 expect(doc.paths['/dynamic'].get.responses['200']).toBeUndefined();
 }finally{await rm(root,{recursive:true,force:true});}
});
