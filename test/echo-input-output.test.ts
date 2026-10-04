import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('separates Echo decoding fields from serialized response required fields',async()=>{
 const root=await mkdtemp(join(tmpdir(),'echo-direction-'));
 try{
 await writeFile(join(root,'go.mod'),'module example\ngo 1.22\nrequire github.com/labstack/echo/v4 v4.0.0');
 await writeFile(join(root,'main.go'),`package main
import "github.com/labstack/echo/v4"
type Item struct {Name string \x60json:"name"\x60; Count int \x60json:"count"\x60}
func handle(c echo.Context)error{var item Item;if err:=c.Bind(&item);err!=nil{return err};return c.JSON(200,item)}
func main(){e:=echo.New();e.POST("/items",handle)}`);
 const doc=(await (await scanProject({root})).convert()).document as any;
 const op=doc.paths['/items'].post;
 const input=doc.components.schemas[op.requestBody.content['application/json'].schema.$ref.split('/').pop()];
 const output=doc.components.schemas[op.responses['200'].content['application/json'].schema.$ref.split('/').pop()];
 expect(input.required??[]).toEqual([]);
 expect(output.required.sort()).toEqual(['count','name']);
 expect(input.properties).toEqual(output.properties);
 }finally{await rm(root,{recursive:true,force:true});}
});
it('uses Gin binding validation for input while preserving all serialized output fields',async()=>{
 const root=await mkdtemp(join(tmpdir(),'gin-direction-'));
 try{
 await writeFile(join(root,'go.mod'),'module example\ngo 1.22\nrequire github.com/gin-gonic/gin v1.4.0');
 await writeFile(join(root,'main.go'),`package main
import "github.com/gin-gonic/gin"
type Item struct {Name string \x60json:"name" binding:"required,min=2"\x60; Count int \x60json:"count"\x60}
func handle(c *gin.Context){var item Item;if err:=c.ShouldBindJSON(&item);err!=nil{c.Status(400);return};c.JSON(200,item)}
func main(){e:=gin.New();e.POST("/items",handle)}`);
 const doc=(await (await scanProject({root})).convert()).document as any;
 const op=doc.paths['/items'].post;
 const input=doc.components.schemas[op.requestBody.content['application/json'].schema.$ref.split('/').pop()];
 const output=doc.components.schemas[op.responses['200'].content['application/json'].schema.$ref.split('/').pop()];
 expect(input.required).toEqual(['name']);
 expect(input.properties.name.minLength).toBe(2);
 expect(output.required.sort()).toEqual(['count','name']);
 expect(output.properties.name.minLength).toBeUndefined();
 }finally{await rm(root,{recursive:true,force:true});}
});
it('follows the matching Echo binding helper and ignores unrelated or nested context calls',async()=>{
 const root=await mkdtemp(join(tmpdir(),'echo-binding-scope-'));
 try{
 await writeFile(join(root,'go.mod'),'module example\ngo 1.22\nrequire github.com/labstack/echo/v4 v4.1.16');
 await writeFile(join(root,'main.go'),`package main
import "github.com/labstack/echo/v4"
type Input struct {Name string \x60json:"name"\x60}
func(r *Input) Bind(c echo.Context)error{return c.Bind(r)}
type Other struct{}
func(o *Other)JSON(code int,v interface{})error{return nil}
func(o *Other)bind(c echo.Context)error{return nil}
func handle(c echo.Context)error{var input Input;if err:=input.Bind(c);err!=nil{return err};unused:=func()error{return c.JSON(201,"not called")};_ = unused;other:=Other{};other.JSON(202,"not HTTP");return c.JSON(200,input)}
func unrelated(c echo.Context)error{other:=Other{};other.bind(c);return c.NoContent(204)}
func main(){e:=echo.New();e.POST("/items",handle);e.POST("/unrelated",unrelated)}`);
 const doc=(await (await scanProject({root})).convert()).document as any;
 expect(Object.keys(doc.paths['/items'].post.responses)).toEqual(['200']);
 expect(doc.paths['/items'].post.requestBody.content['application/json'].schema.$ref).toContain('input_Input');
 expect(doc.paths['/unrelated'].post.requestBody).toBeUndefined();
 }finally{await rm(root,{recursive:true,force:true});}
});
it('preserves same-named parameters in distinct HTTP locations',async()=>{
 const root=await mkdtemp(join(tmpdir(),'echo-parameter-locations-'));
 try{
 await writeFile(join(root,'go.mod'),'module example\ngo 1.22\nrequire github.com/labstack/echo/v4 v4.1.16');
 await writeFile(join(root,'main.go'),`package main
import "github.com/labstack/echo/v4"
func handle(c echo.Context)error{_ = c.Param("id");_ = c.QueryParam("id");_ = c.Request().Header.Get("id");_,_ = c.Cookie("id");return c.NoContent(204)}
func main(){e:=echo.New();e.GET("/items/:id",handle)}`);
 const doc=(await (await scanProject({root})).convert()).document as any;
 expect(doc.paths['/items/{id}'].get.parameters.map((p:any)=>p.in+':'+p.name).sort()).toEqual(['cookie:id','header:id','path:id','query:id']);
 }finally{await rm(root,{recursive:true,force:true});}
});
