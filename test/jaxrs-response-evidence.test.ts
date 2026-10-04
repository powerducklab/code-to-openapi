import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('honors text media and does not invent success for a throwing JAX-RS method',async()=>{
 const root=await mkdtemp(join(tmpdir(),'jaxrs-evidence-'));
 try{
 await writeFile(join(root,'Resource.java'),`import javax.ws.rs.*; import javax.ws.rs.core.MediaType;
@Path("/api") public class Resource {
 @GET @Path("/text") @Produces(MediaType.TEXT_PLAIN) public String text(){return "hello";}
 @GET @Path("/fail") @Produces(MediaType.APPLICATION_JSON) public String fail(){throw new IllegalArgumentException();}
}`);
 const result=await scanProject({root});const converted=await result.convert();
 expect(converted.documentValid).toBe(true);const doc=converted.document as any;
 expect(doc.paths['/api/text'].get.responses['200'].content['text/plain'].schema.type).toBe('string');
 expect(doc.paths['/api/fail'].get.responses['200']).toBeUndefined();
 expect(doc.paths['/api/fail'].get.responses.default).toBeDefined();
 expect(result.project.operations.find(o=>(o.fullPath??o.path)==='/api/fail')?.gaps).toContain('response-unknown');
 }finally{await rm(root,{recursive:true,force:true});}
});

it('uses returned builder order and ignores discarded or nested responses',async()=>{
 const root=await mkdtemp(join(tmpdir(),'jaxrs-builder-'));
 try{
 await writeFile(join(root,'Resource.java'),`import javax.ws.rs.*;import javax.ws.rs.core.Response;import javax.ws.rs.core.MediaType;
@Path("/api") public class Resource {
 @GET @Path("/ordered") public Response ordered(){Response.status(418).build();return Response.ok("first").status(201).entity(new Payload()).type(MediaType.APPLICATION_JSON).build();}
 @GET @Path("/text") public Response text(){return Response.ok("hello").type(MediaType.TEXT_PLAIN).build();}
 @GET @Path("/dynamic") public Response dynamic(@QueryParam("status") int status){return Response.status(status).build();}
 @GET @Path("/nested") public Response nested(){Runnable ignored=()->{Response.status(202).build();};return Response.noContent().build();}
}
class Payload {public String value;}`);
 const result=await scanProject({root});const doc=(await result.convert()).document as any;
 expect(Object.keys(doc.paths['/api/ordered'].get.responses)).toEqual(['201']);
 expect(doc.paths['/api/ordered'].get.responses['201'].content['application/json'].schema.$ref).toBeDefined();
 expect(doc.paths['/api/text'].get.responses['200'].content['text/plain']).toBeDefined();
 expect(doc.paths['/api/dynamic'].get.responses['200']).toBeUndefined();
 expect(Object.keys(doc.paths['/api/nested'].get.responses)).toEqual(['204']);
 }finally{await rm(root,{recursive:true,force:true});}
});

it('matches exception mapper inheritance and closest provider without guessing from exception names',async()=>{
 const root=await mkdtemp(join(tmpdir(),'jaxrs-mapper-'));
 try{
 await writeFile(join(root,'Resource.java'),`import javax.ws.rs.*;
@Path("/api") public class Resource {
 @GET @Path("/base") public String base(){throw new BaseError();}
 @GET @Path("/child") public String child(){throw new ChildError();}
 @GET @Path("/unrelated") public String unrelated(){throw new BadRequestException();}
}
class BaseError extends RuntimeException{} class ChildError extends BaseError{} class BadRequestException extends RuntimeException{}
`);
 await writeFile(join(root,'BaseMapper.java'),`import javax.ws.rs.ext.*;import javax.ws.rs.core.Response;
@Provider public class BaseMapper implements ExceptionMapper<BaseError>{public Response toResponse(BaseError error){return Response.status(400).entity(new ErrorPayload()).build();}}
class ErrorPayload{public String message;}
`);
 await writeFile(join(root,'ChildMapper.java'),`import javax.ws.rs.ext.*;import javax.ws.rs.core.Response;
@Provider public class ChildMapper implements ExceptionMapper<ChildError>{public Response toResponse(ChildError error){return Response.status(409).entity("conflict").type("text/plain").build();}}
class NotRegistered implements ExceptionMapper<BadRequestException>{public Response toResponse(BadRequestException error){return Response.status(418).build();}}
`);
 const result=await scanProject({root});const doc=(await result.convert()).document as any;
 expect(Object.keys(doc.paths['/api/base'].get.responses)).toEqual(['400']);
 expect(Object.keys(doc.paths['/api/child'].get.responses)).toEqual(['409']);
 expect(doc.paths['/api/child'].get.responses['409'].content['text/plain'].schema.type).toBe('string');
 expect(Object.keys(doc.paths['/api/unrelated'].get.responses)).toEqual(['default']);
 }finally{await rm(root,{recursive:true,force:true});}
});

it('retains each same-status response shape and media type',async()=>{
 const root=await mkdtemp(join(tmpdir(),'jaxrs-variants-'));
 try{
 await writeFile(join(root,'Resource.java'),`import javax.ws.rs.*;import javax.ws.rs.core.Response;
@Path("/api") public class Resource {
 @GET public Response value(@QueryParam("choice") int choice){
 if(choice==1)return Response.ok(new First()).build();
 if(choice==2)return Response.ok(new Second()).build();
 if(choice==3)return Response.ok("text").type("text/plain").build();
 return Response.ok(new First()).build();
 }}
class First{public String first;} class Second{public int second;}`);
 const result=await scanProject({root});const doc=(await result.convert()).document as any;
 const content=doc.paths['/api'].get.responses['200'].content;
 expect(content['application/json'].schema.anyOf).toHaveLength(2);
 expect(content['text/plain'].schema.type).toBe('string');
 }finally{await rm(root,{recursive:true,force:true});}
});
