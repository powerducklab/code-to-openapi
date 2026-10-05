import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it.each(['spring','micronaut','jaxrs'])('does not infer success from the declared return of a throwing %s handler',async(framework)=>{
 const root=await mkdtemp(join(tmpdir(),'java-throw-'));
 try{
 const spring=framework==='spring';const jaxrs=framework==='jaxrs';
 await writeFile(join(root,'Api.java'),`${spring?'import org.springframework.web.bind.annotation.*;':jaxrs?'import javax.ws.rs.*;':'import io.micronaut.http.annotation.*;'}
${spring?'@RestController @RequestMapping("/api")':jaxrs?'@Path("/api")':'@Controller("/api")'} class Api {
 ${spring?'@GetMapping("/fail")':jaxrs?'@GET @Path("/fail")':'@Get("/fail")'} public String fail(){java.util.function.Supplier<String> unused=()->{return "unused";};throw new IllegalStateException();}
 ${spring?'@GetMapping("/mixed")':jaxrs?'@GET @Path("/mixed")':'@Get("/mixed")'} public String mixed(){if(System.nanoTime()>0)return "ok";throw new IllegalStateException();}
}`);
 const result=await scanProject({root});const doc=(await result.convert()).document as any;
 const failGaps=result.project.operations.find(o=>(o.fullPath??o.path)==='/api/fail')?.gaps;
 if(framework==='micronaut'){
  // Micronaut's default ExceptionHandler renders any unhandled domain exception
  // as a 500 JSON error; the error body shape is not statically proven.
  expect(Object.keys(doc.paths['/api/fail'].get.responses)).toEqual(['500']);
  expect(doc.paths['/api/mixed'].get.responses['200']).toBeDefined();
  expect(doc.paths['/api/mixed'].get.responses['500']).toBeDefined();
  expect(failGaps).toContain('response-schema-unknown');
 }else{
  expect(Object.keys(doc.paths['/api/fail'].get.responses)).toEqual(['default']);
  expect(doc.paths['/api/mixed'].get.responses['200']).toBeDefined();
  expect(failGaps).toContain('response-unknown');
 }
 }finally{await rm(root,{recursive:true,force:true});}
});
