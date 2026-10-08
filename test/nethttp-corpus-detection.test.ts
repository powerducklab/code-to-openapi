import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {scanProject} from '../src/index.js';
it('does not reject a stdlib server because comments mention gorilla/mux',async()=>{
 const root=await mkdtemp(join(tmpdir(),'stdlib-comments-'));
 try{
  await writeFile(join(root,'go.mod'),'module example.local/api\ngo 1.22');
  await writeFile(join(root,'main.go'),`package main
import "net/http"
// Migrated from gorilla/mux; no third-party router is used.
type Server struct { mux *http.ServeMux }
func(s *Server) routes(){s.mux.HandleFunc("GET /field",func(w http.ResponseWriter,r *http.Request){w.WriteHeader(204)})}
func main(){mux:=http.NewServeMux();mux.HandleFunc("GET /ping",func(w http.ResponseWriter,r *http.Request){w.WriteHeader(204)});http.ListenAndServe(":8080",mux)}`);
  const r=await scanProject({root});expect(r.report.frameworks).toContain('nethttp');expect(r.project.operations.map(o=>o.fullPath??o.path).sort()).toEqual(['/field','/ping']);
 }finally{await rm(root,{recursive:true,force:true});}
});
it('extracts Alice terminal contracts and retains unverified middleware gaps',async()=>{
 const root=await mkdtemp(join(tmpdir(),'stdlib-alice-'));
 try {
  await writeFile(join(root,'go.mod'),'module example.local/api\ngo 1.22');
  await writeFile(join(root,'main.go'),`package main
import (
 "net/http"
 "encoding/json"
 "github.com/justinas/alice"
)
type Server struct { mux *http.ServeMux }
type Input struct { Name string \`json:"name"\` }
type Output struct { ID int \`json:"id"\` }
func(s *Server) chain() alice.Chain { return alice.New() }
func(s *Server) create(w http.ResponseWriter,r *http.Request){var input Input;json.NewDecoder(r.Body).Decode(&input);json.NewEncoder(w).Encode(Output{ID:1})}
func(s *Server) routes(){s.mux.Handle("POST /items",s.chain().Append().ThenFunc(s.create))}
func main(){}
`);
  const {project}=await scanProject({root,frameworks:['nethttp']});
  expect(project.operations).toHaveLength(1);
  const op=project.operations[0]!;
  expect(op.requestBody).toBeDefined();
  expect(op.responses?.length).toBeGreaterThan(0);
  expect(op.gaps).toContain('auth-unknown');
  expect(project.unresolved?.some(item=>item.message.includes('middleware'))).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});
