import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {scanProject} from '../src/index.js';
it('resolves Echo path constants and sequential local assignments without dropping dynamic prefixes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'echo-static-'));
 try{
 await writeFile(join(root,'go.mod'),'module example.com/demo\ngo 1.22\nrequire github.com/labstack/echo/v4 v4.12.0');
 await writeFile(join(root,'main.go'),`package main
import("fmt"; "os"; "github.com/labstack/echo/v4")
const(version="/v1"; users=version+"/users"; id="id")
func main(){
 e:=echo.New()
 g:=e.Group(users)
 { path:=""; g.GET(path, handle); path=fmt.Sprintf("/:%s",id); g.GET(path,makeHandler()) }
 unknown:=e.Group(os.Getenv("PREFIX")); unknown.GET("/hidden",handle)
 { path:="/wrong"; if os.Getenv("PATH")!="" {path="/different"}; g.GET(path,makeHandler()) }
}
func handle(c echo.Context)error{return c.NoContent(204)}
func makeHandler() echo.HandlerFunc {return func(c echo.Context)error{return c.JSON(200,struct{ID int \`json:"id"\`}{ID:1})}}
`);
 const result=await scanProject({root,frameworks:['echo']});
 expect(result.project.operations.map(op=>op.path).sort()).toEqual(['/v1/users','/v1/users/{id}']);
 expect(result.project.operations.find(op=>op.path.endsWith('{id}'))?.responses[0]?.statusCode).toBe('200');
 expect(result.project.operations.find(op=>op.path.endsWith('{id}'))?.gaps).not.toContain('response-unknown');
 expect((await result.convert()).documentValid).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});
