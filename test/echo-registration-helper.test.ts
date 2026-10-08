import {mkdtemp, writeFile, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, it} from 'vitest';
import {scanProject} from '../src/index.js';

it('binds imported Echo registration arguments per invocation, resolves factories and isolates lexical scopes', async () => {
 const root = await mkdtemp(join(tmpdir(), 'echo-registration-'));
 try {
  await mkdir(join(root, 'v1'));
  await writeFile(join(root, 'go.mod'), 'module example.com/demo\ngo 1.22\nrequire github.com/labstack/echo/v4 v4.12.0');
  await writeFile(join(root, 'main.go'), `package main
import (web "github.com/labstack/echo/v4"; "example.com/demo/v1")
func main(){
 e:=server()
 v1:=e.Group("/api/v1")
 v2:=e.Group("/api/v2")
 controllers.Register("ignored",v1)
 controllers.Register("ignored",v2)
 { e:=other(); e.GET("/not-echo",nil) }
 e.GET("/health",func(c web.Context)error{return c.NoContent(204)})
}
func server()*web.Echo{ e:=web.New(); e.Use(func(next web.HandlerFunc)web.HandlerFunc{return next}); return e }
func unused(group *web.Group){group.GET("/unused",nil)}
func other() interface{} {return nil}
`);
  await writeFile(join(root, 'v1', 'routes.go'), `package controllers
import ("fmt"; "github.com/labstack/echo/v4")
const prefix="/users"
func Register(label string, group *echo.Group){
 path:=fmt.Sprintf("%s/:id",prefix)
 group.GET(path,func(c echo.Context)error{if err:=problem();err!=nil{return err};return c.JSON(201,struct{Name string \`json:"name"\`}{Name:"demo"})})
 nested:=group.Group("/nested")
 install(nested)
}
func install(group *echo.Group){group.POST("/item",func(c echo.Context)error{return c.NoContent(204)}); recur(group)}
func recur(group *echo.Group){install(group)}
func problem()error{return nil}
func unused(group *echo.Group){group.GET("/orphan",nil)}
`);
  const result = await scanProject({root, frameworks:['echo']});
  expect(result.project.operations.map(op=>op.path).sort()).toEqual([
   '/api/v1/nested/item','/api/v1/users/{id}','/api/v2/nested/item','/api/v2/users/{id}','/health',
  ]);
  for (const op of result.project.operations.filter(op=>op.path.endsWith('{id}'))) {
   expect(op.responses.map(r=>r.statusCode)).toEqual(['201']);
   expect(op.gaps).toContain('response-unknown');
   expect(op.parameters).toEqual(expect.arrayContaining([expect.objectContaining({name:'id',in:'path',required:true})]));
  }
  expect((await result.convert()).documentValid).toBe(true);
 } finally { await rm(root, {recursive:true,force:true}); }
});
