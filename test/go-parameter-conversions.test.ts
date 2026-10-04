import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('uses verified strconv aliases for path/query types and rejects a shadowed package',async()=>{
 const root=await mkdtemp(join(tmpdir(),'go-conversions-'));
 try{
 await writeFile(join(root,'main.go'),`package main
import("net/http";conv "strconv")
func item(w http.ResponseWriter,r *http.Request){conv.Atoi(r.PathValue("id"));conv.ParseBool(r.URL.Query().Get("active"));conv.ParseFloat(r.URL.Query().Get("score"),64)}
func shadow(w http.ResponseWriter,r *http.Request){conv:=other();conv.Atoi(r.URL.Query().Get("text"))}
func main(){m:=http.NewServeMux();m.HandleFunc("GET /items/{id}",item);m.HandleFunc("GET /shadow",shadow)}`);
 const result=await scanProject({root});const converted=await result.convert();
 expect(converted.documentValid).toBe(true);
 const doc=converted.document as any;
 expect(doc.paths['/items/{id}'].get.parameters.map((p:any)=>[p.name,p.schema.type])).toEqual(expect.arrayContaining([['id','integer'],['active','boolean'],['score','number']]));
 expect(doc.paths['/shadow'].get.parameters[0].schema.type).toBe('string');
 }finally{await rm(root,{recursive:true,force:true});}
});
