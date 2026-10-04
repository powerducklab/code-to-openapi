import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('honors Micronaut builder order and response scope',async()=>{
 const root=await mkdtemp(join(tmpdir(),'micronaut-chain-'));
 try{
 await writeFile(join(root,'Controller.java'),`import io.micronaut.http.annotation.*;import io.micronaut.http.HttpResponse;import io.micronaut.http.HttpStatus;
@Controller("/api")class Api {
 @Get("/order")public HttpResponse<?> order(){return HttpResponse.ok("first").status(HttpStatus.CREATED).body(new Payload());}
 @Get("/created")public HttpResponse<?> created(){return HttpResponse.created("payload");}
 @Get("/location")public HttpResponse<?> location(){return HttpResponse.created(java.net.URI.create("/items/1"));}
 @Get("/nested")public HttpResponse<?> nested(){java.util.function.Supplier<?> ignored=()->{return HttpResponse.created("ignored");};return HttpResponse.noContent();}
 @Get("/dynamic")public HttpResponse<?> dynamic(@QueryValue HttpStatus code){return HttpResponse.status(code);}
 @Get("/variants")public HttpResponse<?> variants(@QueryValue boolean first){if(first)return HttpResponse.ok(new Payload());return HttpResponse.ok("second");}
}
class Payload{public String value;}`);
 const result=await scanProject({root});const doc=(await result.convert()).document as any;
 expect(Object.keys(doc.paths['/api/order'].get.responses)).toEqual(['201']);
 expect(doc.paths['/api/order'].get.responses['201'].content['application/json'].schema.$ref).toBeDefined();
 expect(doc.paths['/api/created'].get.responses['201'].content['application/json'].schema.type).toBe('string');
 expect(doc.paths['/api/location'].get.responses['201'].content).toBeUndefined();
 expect(Object.keys(doc.paths['/api/nested'].get.responses)).toEqual(['204']);
 expect(Object.keys(doc.paths['/api/dynamic'].get.responses)).toEqual(['default']);
 expect(doc.paths['/api/variants'].get.responses['200'].content['application/json'].schema.anyOf).toHaveLength(2);
 }finally{await rm(root,{recursive:true,force:true});}
});
