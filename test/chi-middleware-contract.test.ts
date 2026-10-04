import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('keeps registered group middleware errors within that group',async()=>{
 const root=await mkdtemp(join(tmpdir(),'chi-middleware-'));
 try{
 await writeFile(join(root,'main.go'),`package main
import("net/http";"github.com/go-chi/chi")
func guard(next http.Handler) http.Handler{return http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){if r.Header.Get("token")==""{http.Error(w,"missing",http.StatusUnauthorized);return};next.ServeHTTP(w,r)})}
func handler(w http.ResponseWriter,r *http.Request){w.WriteHeader(204)}
func main(){r:=chi.NewRouter();r.Get("/public",handler);r.Route("/private",func(s chi.Router){s.Use(guard);s.Get("/item",handler)})}`);
 const result=await scanProject({root});const converted=await result.convert();expect(converted.documentValid).toBe(true);const doc=converted.document as any;
 expect(doc.paths['/private/item'].get.responses['401'].content['text/plain'].schema.type).toBe('string');
 expect(doc.paths['/public'].get.responses['401']).toBeUndefined();
 }finally{await rm(root,{recursive:true,force:true});}
});
