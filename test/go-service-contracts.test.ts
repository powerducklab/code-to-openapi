import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';

it('resolves interface service results and nested JSON field names without private fields',async()=>{
 const root=await mkdtemp(join(tmpdir(),'go-service-'));
 try{
 await writeFile(join(root,'main.go'),`package main
import("net/http";"encoding/json")
type User struct { Profile struct { DisplayName string \`json:"display_name"\`; secret string; Hidden string \`json:"-"\` } \`json:"profile"\` }
type Store interface { Get() (User,error); List() ([]User,error) }
type Server struct { store Store }
func(s *Server)handler(w http.ResponseWriter,r *http.Request){user,err:=s.store.Get();if err!=nil{return};json.NewEncoder(w).Encode(user)}
func pagination(r *http.Request){q:=r.URL.Query();q.Get("offset");unused:=func(){r.URL.Query().Get("closure")};pagination(r)}
func unrelated(r *http.Request){r.URL.Query().Get("unrelated")}
func(s *Server)list(w http.ResponseWriter,r *http.Request){pagination(r);users,err:=s.store.List();if err!=nil{return};total:=len(users);json.NewEncoder(w).Encode(map[string]any{"count":len(users),"total":total,"users":users,"meta":map[string]any{"users":users}})}
func main(){m:=http.NewServeMux();s:=&Server{};m.HandleFunc("GET /user",s.handler);m.HandleFunc("GET /users",s.list)}`);
 const result=await scanProject({root});const converted=await result.convert();
 expect(converted.documentValid).toBe(true);
 const doc=converted.document as any;
 expect(doc.paths['/user'].get.responses['200'].content['application/json'].schema).toEqual({$ref:'#/components/schemas/User'});
 expect(doc.paths['/users'].get.parameters.map((p:any)=>p.name)).toContain('offset');
 expect(doc.paths['/users'].get.parameters.map((p:any)=>p.name)).not.toContain('unrelated');
 expect(doc.paths['/users'].get.parameters.map((p:any)=>p.name)).not.toContain('closure');
 expect(doc.paths['/users'].get.responses['200'].content['application/json'].schema.properties.users).toEqual({type:['array','null'],items:{$ref:'#/components/schemas/User'}});
 expect(doc.paths['/users'].get.responses['200'].content['application/json'].schema.properties.meta.properties.users).toEqual({type:['array','null'],items:{$ref:'#/components/schemas/User'}});
 expect(doc.paths['/users'].get.responses['200'].content['application/json'].schema.properties.count).toEqual({type:'integer',minimum:0});
 expect(doc.paths['/users'].get.responses['200'].content['application/json'].schema.properties.total).toEqual({type:'integer',minimum:0});
 expect(Object.keys(doc.components.schemas.User.properties.profile.properties)).toEqual(['display_name']);
 }finally{await rm(root,{recursive:true,force:true});}
});
