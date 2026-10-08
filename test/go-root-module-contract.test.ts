import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {scanProject} from '../src/index.js';
it('resolves root-module DTOs and new(package.Type) JSON bodies',async()=>{
 const root=await mkdtemp(join(tmpdir(),'go-root-module-'));
 try {
  await mkdir(join(root,'server'));
  await writeFile(join(root,'go.mod'),'module example.local/api\ngo 1.22');
  await writeFile(join(root,'model.go'),`package api
type Input struct { Title string \`json:"title"\`; Count int \`json:"count"\` }
type Output struct { ID string \`json:"id"\` }
`);
  await writeFile(join(root,'server','main.go'),`package server
import (
 "net/http"
 "encoding/json"
 "example.local/api"
)
func create(w http.ResponseWriter,r *http.Request){input:=new(api.Input);json.NewDecoder(r.Body).Decode(input);var output api.Output;json.NewEncoder(w).Encode(output)}
func main(){http.HandleFunc("POST /items",create)}
`);
  const result=await scanProject({root,frameworks:['nethttp']});
  const converted=await result.convert({validate:true});
  expect(converted.documentValid).toBe(true);
  const schemas=converted.document.components!.schemas! as Record<string,any>;
  expect(Object.values(schemas).some(s=>s.properties?.title?.type==='string' && s.properties?.count?.type==='integer')).toBe(true);
  expect(Object.values(schemas).some(s=>s.properties?.id?.type==='string')).toBe(true);
  expect(result.project.operations[0]!.gaps).not.toContain('body-schema-unknown');
  expect(result.project.operations[0]!.gaps).not.toContain('response-schema-unknown');
 }finally{await rm(root,{recursive:true,force:true});}
});
