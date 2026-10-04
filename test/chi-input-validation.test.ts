import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('separates validated JSON input from ignored validation and response fields',async()=>{
 const root=await mkdtemp(join(tmpdir(),'chi-validation-'));
 try{
 await writeFile(join(root,'main.go'),`package main
import("net/http";"encoding/json";"github.com/go-chi/chi";"github.com/go-playground/validator/v10")
type Input struct{Name string \`json:"name" validate:"required,min=2"\`; Title *string \`json:"title" validate:"required,min=1"\`; Content *string \`json:"content" validate:"omitempty,min=1"\`}
type Server struct{Validate *validator.Validate}
func(s *Server)checked(w http.ResponseWriter,r *http.Request){var input Input;json.NewDecoder(r.Body).Decode(&input);err:=s.Validate.Struct(input);if err!=nil{http.Error(w,"bad",400);return};json.NewEncoder(w).Encode(input)}
func(s *Server)ignored(w http.ResponseWriter,r *http.Request){var input Input;json.NewDecoder(r.Body).Decode(&input);s.Validate.Struct(input);json.NewEncoder(w).Encode(input)}
func main(){r:=chi.NewRouter();s:=&Server{};r.Post("/checked",s.checked);r.Post("/ignored",s.ignored)}`);
 const result=await scanProject({root});const converted=await result.convert();expect(converted.documentValid).toBe(true);const doc=converted.document as any;
 expect(doc.paths['/checked'].post.requestBody.content['application/json'].schema.$ref).toBe('#/components/schemas/validated_input_Input');
 expect(doc.components.schemas.validated_input_Input.properties.name.minLength).toBe(2);
 expect(doc.components.schemas.validated_input_Input.required).toEqual(['name','title']);
 expect(doc.components.schemas.validated_input_Input.properties.title).toEqual({type:'string',minLength:1});
 expect(doc.components.schemas.validated_input_Input.properties.content).toEqual({type:['string','null'],minLength:1});
 expect(doc.paths['/ignored'].post.requestBody.content['application/json'].schema.$ref).toBe('#/components/schemas/input_Input');
 expect(doc.components.schemas.input_Input.required).toBeUndefined();
 expect(doc.components.schemas.Input.properties.name.minLength).toBeUndefined();
 }finally{await rm(root,{recursive:true,force:true});}
});
