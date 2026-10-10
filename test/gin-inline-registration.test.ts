import {it,expect} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('follows inline nested Gin groups and bounds recursive registrations',async()=>{
 const root=await mkdtemp(join(tmpdir(),'gin-inline-'));
 try {
  await writeFile(join(root,'main.go'),`package main
import "github.com/gin-gonic/gin"
func main(){
 r:=gin.Default()
 api:=r.Group("/api")
 register(api.Group("/users").Group("/v2"))
 register(api.Group("/admin"))
 api.Group("/inline").GET("/route",show)
 recursive(api.Group("/tree"))
 dynamic:=api.Group(prefix)
 dynamic.GET("/invented",show)
}
func register(router *gin.RouterGroup){router.GET("",show)}
func recursive(router *gin.RouterGroup){router.GET("",show);recursive(router.Group("/child"))}
func show(c *gin.Context){c.JSON(200,gin.H{"ok":true})}
`);
  const result=await scanProject({root});
  const paths=result.project.operations.map(op=>op.path);
  expect(paths).toContain('/api/users/v2');expect(paths).toContain('/api/admin');
  expect(paths).toContain('/api/inline/route');
  expect(paths).not.toContain('/api/invented');
  expect(paths.filter(p=>p.startsWith('/api/tree'))).toHaveLength(1);
  expect(result.project.unresolved.some(u=>u.message?.includes('Recursive Gin'))).toBe(true);
  expect(result.project.unresolved.some(u=>u.message?.includes('group prefix'))).toBe(true);
  expect((await result.convert()).documentValid).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});
