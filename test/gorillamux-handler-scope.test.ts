import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('resolves a registered receiver method instead of a same-name package function',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mux-scope-'));
 try{
 await writeFile(join(root,'main.go'),`package main
import("net/http";"encoding/json";"strconv";"github.com/gorilla/mux")
type App struct{}
func users() string{return "not a handler"}
func(a *App)users(w http.ResponseWriter,r *http.Request){vars:=mux.Vars(r);strconv.Atoi(vars["id"]);json.NewEncoder(w).Encode(map[string]string{"actual":"handler"})}
func main(){r:=mux.NewRouter();a:=&App{};r.HandleFunc("/users/{id}",a.users).Methods("GET")}`);
 const result=await scanProject({root});const converted=await result.convert();expect(converted.documentValid).toBe(true);
 const doc=converted.document as any;expect(doc.paths['/users/{id}'].get.parameters[0].schema.type).toBe('integer');expect(doc.paths['/users/{id}'].get.responses['200'].content['application/json'].schema.properties.actual.type).toBe('string');
 }finally{await rm(root,{recursive:true,force:true});}
});
