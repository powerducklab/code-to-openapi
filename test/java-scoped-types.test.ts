import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('does not resolve missing Java imports or qualified types through unrelated short-name classes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'java-scoped-'));
 try{
 await writeFile(join(root,'One.java'),`package one; public record Payload(String first){}`);
 await writeFile(join(root,'Two.java'),`package two; public record Payload(Integer second){}`);
 await writeFile(join(root,'Good.java'),`package api; import javax.ws.rs.*; import two.Payload; @Path("/good") public class Good { @GET public Payload get(){return null;} }`);
 await writeFile(join(root,'Missing.java'),`package missing; import javax.ws.rs.*; import absent.Payload; @Path("/missing") public class Missing { @GET public Payload get(){return null;} }`);
 await writeFile(join(root,'Qualified.java'),`package api; import javax.ws.rs.*; @Path("/qualified") public class Qualified { @GET public absent.Payload get(){return null;} }`);
 await writeFile(join(root,'Ambiguous.java'),`package api; import javax.ws.rs.*; import one.*; import two.*; @Path("/ambiguous") public class Ambiguous { @GET public Payload get(){return null;} }`);
 await writeFile(join(root,'Nested.java'),`package api; import javax.ws.rs.*; import one.Payload; @Path("/nested") public class Nested {public record Payload(Integer inner){} @GET public Payload get(){return null;} }`);
 const result=await scanProject({root});const doc=(await result.convert()).document as any;
 const resolve=(schema:any)=>schema?.$ref?doc.components.schemas[schema.$ref.split('/').pop()]:schema;
 const schema=(path:string)=>resolve(doc.paths[path].get.responses['200'].content['application/json'].schema);
 expect(schema('/good').properties.second.type).toBe('integer');
 expect(schema('/nested').properties.inner.type).toBe('integer');
 for(const path of ['/missing','/qualified','/ambiguous']){
  expect(schema(path)?.properties).toBeUndefined();
  expect(result.project.operations.find(op=>op.path===path)?.gaps.length).toBeGreaterThan(0);
 }
 }finally{await rm(root,{recursive:true,force:true});}
});
