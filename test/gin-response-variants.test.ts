import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('preserves same-status Gin response branches',async()=>{
 const root=await mkdtemp(join(tmpdir(),'gin-variants-'));
 try{
  await writeFile(join(root,'go.mod'),'module example\ngo 1.22\nrequire github.com/gin-gonic/gin v1.9.1');
  await writeFile(join(root,'main.go'),`package main
import "github.com/gin-gonic/gin"
func handle(c *gin.Context){if c.Query("shape")=="one"{c.JSON(200,gin.H{"first":"value"});return};c.JSON(200,gin.H{"second":42})}
func main(){r:=gin.New();r.GET("/variants",handle)}
`);
 const doc=(await (await scanProject({root})).convert()).document as any;
 const variants=doc.paths['/variants'].get.responses['200'].content['application/json'].schema.anyOf;
 expect(variants).toHaveLength(2);
 expect(variants.map((s:any)=>Object.keys(s.properties)[0]).sort()).toEqual(['first','second']);
 }finally{await rm(root,{recursive:true,force:true});}
});
