import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('follows a proven JSON writer and preserves success/error statuses',async()=>{
 const root=await mkdtemp(join(tmpdir(),'http-writer-'));
 try{
 await writeFile(join(root,'main.go'),`package main
import("net/http";"encoding/json")
type Data struct{Name string}
type Server struct{}
func reply(w http.ResponseWriter,code int,data any){w.WriteHeader(code);if data!=nil{json.NewEncoder(w).Encode(data)}}
func(s *Server)handler(w http.ResponseWriter,r *http.Request){if r.URL.Path=="/bad"{reply(w,http.StatusBadRequest,Data{Name:"bad"});return};reply(w,http.StatusOK,Data{Name:"ok"})}
func failure(w http.ResponseWriter,code int,message string){reply(w,code,map[string]string{"error":message})}
func remove(w http.ResponseWriter,r *http.Request){if r.URL.Path=="/bad"{failure(w,400,"bad");return};reply(w,http.StatusNoContent,nil)}
func main(){m:=http.NewServeMux();s:=&Server{};m.HandleFunc("GET /item",s.handler);m.HandleFunc("DELETE /item",remove)}`);
 const result=await scanProject({root});const converted=await result.convert();expect(converted.documentValid).toBe(true);
 const doc=converted.document as any;expect(Object.keys(doc.paths['/item'].get.responses)).toEqual(['200','400']);
 expect(doc.paths['/item'].get.responses['200'].content['application/json'].schema).toEqual({$ref:'#/components/schemas/Data'});
 expect(doc.paths['/item'].delete.responses['204'].content).toBeUndefined();
 expect(doc.paths['/item'].delete.responses['400'].content['application/json'].schema).toEqual({type:'object',properties:{error:{type:'string'}},required:['error']});
 }finally{await rm(root,{recursive:true,force:true});}
});

it('recognizes a Marshal/Write wrapper using the actual JSON import',async()=>{
 const root=await mkdtemp(join(tmpdir(),'http-marshal-'));
 try{
 await writeFile(join(root,'main.go'),`package main
import("net/http";"encoding/json";j "encoding/json")
type Data struct{Name string}
func reply(w http.ResponseWriter,code int,data any){encoded,_:=j.Marshal(data);w.WriteHeader(code);w.Write(encoded)}
func handler(w http.ResponseWriter,r *http.Request){var data Data; json.NewDecoder(r.Body).Decode(&data); reply(w,201,Data{Name:"ok"})}
func main(){m:=http.NewServeMux();m.HandleFunc("POST /item",handler)}`);
 const result=await scanProject({root});const converted=await result.convert();expect(converted.documentValid).toBe(true);
 const doc=converted.document as any;
 expect(doc.paths['/item'].post.responses['201'].content['application/json'].schema).toEqual({$ref:'#/components/schemas/Data'});
 expect(doc.paths['/item'].post.requestBody.content['application/json'].schema).toEqual({$ref:'#/components/schemas/input_Data'});
 expect(doc.components.schemas.input_Data.required).toBeUndefined();
 expect(doc.components.schemas.Data.required).toEqual(['Name']);
 }finally{await rm(root,{recursive:true,force:true});}
});
