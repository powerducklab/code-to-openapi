import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';

// Static association of Micronaut error contracts:
//   endpoint throw -> @Error (local/global) or ExceptionHandler<Exc> bean,
//   built-in http.exceptions status types, HttpStatusException(status), and the
//   framework 500 JSON error fallback for unhandled domain exceptions.
it('associates Micronaut @Error methods and ExceptionHandler beans with throws',async()=>{
 const root=await mkdtemp(join(tmpdir(),'micronaut-error-'));
 try{
 await writeFile(join(root,'Controller.java'),`
 import io.micronaut.http.annotation.*;
 import io.micronaut.http.HttpResponse;
 import io.micronaut.http.HttpRequest;
 import io.micronaut.http.HttpStatus;
 import io.micronaut.http.exceptions.NotFoundException;
 import io.micronaut.http.exceptions.HttpStatusException;
 import io.micronaut.http.server.exceptions.ExceptionHandler;
 import jakarta.inject.Singleton;

 class OutOfTeaException extends RuntimeException { OutOfTeaException(String m){super(m);} }
 class LocalTeaException extends RuntimeException { LocalTeaException(String m){super(m);} }

 @Singleton
 class OutOfTeaHandler implements ExceptionHandler<OutOfTeaException, HttpResponse<?>> {
   public HttpResponse<?> handle(HttpRequest request, OutOfTeaException exception) {
     return HttpResponse.unprocessableEntity();
   }
 }
 // A global handler for LocalTeaException must lose to the controller-local @Error.
 @Singleton
 class LocalTeaGlobalHandler implements ExceptionHandler<LocalTeaException, HttpResponse<?>> {
   public HttpResponse<?> handle(HttpRequest request, LocalTeaException exception) {
     return HttpResponse.serverError();
   }
 }

 @Controller("/tea")
 class TeaController {
   @Get("/builtin/{id}")
   public HttpResponse<?> builtin(Long id) {
     if (id == null) { throw new NotFoundException("missing"); }
     return HttpResponse.ok();
   }
   @Get("/status")
   public HttpResponse<?> status() {
     throw new HttpStatusException(HttpStatus.SERVICE_UNAVAILABLE, "down");
   }
   @Get("/plain")
   public HttpResponse<?> plain() {
     throw new RuntimeException("boom");
   }
   @Get("/global")
   public HttpResponse<?> global() {
     throw new OutOfTeaException("none");
   }
   @Get("/local")
   public HttpResponse<?> local() {
     throw new LocalTeaException("none");
   }
   @Error(exception = LocalTeaException.class)
   public HttpResponse<?> onLocalTea(LocalTeaException exception) {
     return HttpResponse.status(HttpStatus.IM_A_TEAPOT);
   }
 }`);
 const result=await scanProject({root});
 const doc=(await result.convert()).document as any;

 // Built-in Micronaut status exception keeps the success branch plus a 404.
 const builtin=doc.paths['/tea/builtin/{id}'].get.responses;
 expect(Object.keys(builtin).sort()).toEqual(['200','404']);
 expect(builtin['404'].content['application/json']).toBeDefined();

 // HttpStatusException carries an explicit status.
 expect(Object.keys(doc.paths['/tea/status'].get.responses)).toEqual(['503']);

 // An unhandled domain exception surfaces as the framework 500 JSON error.
 const plain=doc.paths['/tea/plain'].get.responses;
 expect(Object.keys(plain)).toEqual(['500']);
 expect(plain['500'].content['application/json']).toBeDefined();

 // Global ExceptionHandler<OutOfTeaException> bean wins for that exception.
 expect(Object.keys(doc.paths['/tea/global'].get.responses)).toEqual(['422']);
 expect(doc.paths['/tea/global'].get.responses['422'].content).toBeUndefined();

 // Controller-local @Error takes precedence over a global ExceptionHandler.
 expect(Object.keys(doc.paths['/tea/local'].get.responses)).toEqual(['418']);
 expect(doc.paths['/tea/local'].get.responses['418'].content).toBeUndefined();
 }finally{await rm(root,{recursive:true,force:true});}
});

it('maps a global @Error(status=...) method by response status',async()=>{
 const root=await mkdtemp(join(tmpdir(),'micronaut-error-status-'));
 try{
 await writeFile(join(root,'Errors.java'),`
 import io.micronaut.http.annotation.*;
 import io.micronaut.http.HttpResponse;
 import io.micronaut.http.HttpStatus;
 import io.micronaut.http.exceptions.HttpStatusException;

 @Controller
 class GlobalErrors {
   @Error(status = HttpStatus.NOT_FOUND)
   public HttpResponse<?> notFound() {
     return HttpResponse.status(HttpStatus.NOT_FOUND);
   }
 }

 @Controller("/docs")
 class DocsController {
   @Get("/missing")
   public HttpResponse<?> missing() {
     throw new HttpStatusException(HttpStatus.NOT_FOUND, "absent");
   }
 }`);
 const result=await scanProject({root});
 const doc=(await result.convert()).document as any;
 expect(Object.keys(doc.paths['/docs/missing'].get.responses)).toEqual(['404']);
 expect(doc.paths['/docs/missing'].get.responses['404'].content).toBeUndefined();
 }finally{await rm(root,{recursive:true,force:true});}
});
