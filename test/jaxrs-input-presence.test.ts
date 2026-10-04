import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('does not invent required JAX-RS inputs and retains validated entity parameters',async()=>{
 const root=await mkdtemp(join(tmpdir(),'jaxrs-input-presence-'));
 try{
 await writeFile(join(root,'Api.java'),`import javax.ws.rs.*;import javax.validation.Valid;import javax.validation.constraints.NotNull;
class Item{public String name;}
@Path("/items")class Api{
@POST public Item optional(@Valid Item input){return input;}
@PUT public Item mandatory(@NotNull @Valid Item input){return input;}
@GET public String query(@QueryParam("filter")String filter,@HeaderParam("X-Key")String key,@QueryParam("must")@NotNull String must){return "ok";}
@POST @Path("/form")@Consumes("application/x-www-form-urlencoded")public String form(@FormParam("value")String value){return "ok";}
}`);
 const doc=(await (await scanProject({root})).convert()).document as any;
 expect(doc.paths['/items'].post.requestBody.required??false).toBe(false);
 expect(doc.paths['/items'].post.requestBody.content['application/json'].schema.anyOf).toContainEqual({type:'null'});
 expect(doc.paths['/items'].put.requestBody.required).toBe(true);
 expect(doc.paths['/items'].put.requestBody.content['application/json'].schema.$ref).toBeDefined();
 const params=doc.paths['/items'].get.parameters;
 expect(params.find((p:any)=>p.name==='filter').required??false).toBe(false);
 expect(params.find((p:any)=>p.name==='X-Key').required??false).toBe(false);
 expect(params.find((p:any)=>p.name==='must').required).toBe(true);
 expect(doc.paths['/items/form'].post.requestBody.required??false).toBe(false);
 }finally{await rm(root,{recursive:true,force:true});}
});
