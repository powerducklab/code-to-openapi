import {expect,it} from 'vitest';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';

it('net/http: decode helper to local type, implicit empty 200, and implicit JSON render',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nb5-nethttp-'));
 try{
 await writeFile(join(root,'main.go'),`package main
import("net/http";"encoding/json";"strings";"fmt")
type document struct{Text string}
type addRequest struct{Documents []document}
type queryRequest struct{Content string}
type server struct{}
func readRequestJSON(r *http.Request,v any)error{if !strings.HasPrefix(r.Header.Get("Content-Type"),"application/json"){return fmt.Errorf("bad media")};return json.NewDecoder(r.Body).Decode(v)}
func renderJSON(w http.ResponseWriter,v any){js,_:=json.Marshal(v);w.Header().Set("Content-Type","application/json");w.Write(js)}
func(s *server)add(w http.ResponseWriter,r *http.Request){var req addRequest;if err:=readRequestJSON(r,&req);err!=nil{http.Error(w,err.Error(),400);return};return}
func(s *server)query(w http.ResponseWriter,r *http.Request){var req queryRequest;if err:=readRequestJSON(r,&req);err!=nil{http.Error(w,err.Error(),400);return};renderJSON(w,strings.Join([]string{"ok"},""))}
func main(){m:=http.NewServeMux();s:=&server{};m.HandleFunc("POST /add/",s.add);m.HandleFunc("POST /query/",s.query)}`);
 const result=await scanProject({root});const converted=await result.convert();
 expect(converted.documentValid).toBe(true);const doc=converted.document as any;
 const add=doc.paths['/add/'].post;
 expect(add.requestBody.content['application/json'].schema.$ref).toBe('#/components/schemas/input_addRequest');
 expect(Object.keys(add.responses).sort()).toEqual(['200','400']);
 expect(add.responses['200'].content).toBeUndefined();
 expect(add.responses['400'].content['text/plain']).toBeDefined();
 const query=doc.paths['/query/'].post;
 expect(query.responses['200'].content['application/json'].schema.type).toBe('string');
 }finally{await rm(root,{recursive:true,force:true});}
});

it('nextjs: header guard proves required param; redirect is an empty 307/302',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nb5-next-'));
 try{
 await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{next:'^14'}}));
 await mkdir(join(root,'app/api/webhook'),{recursive:true});
 await writeFile(join(root,'app/api/webhook/route.ts'),`
export async function POST(req:Request){const sig=req.headers.get('stripe-signature');const secret=process.env.WEBHOOK_SECRET;if(!sig||!secret){return new Response('bad',{status:400});}return new Response(JSON.stringify({received:true}));}
`);
 await mkdir(join(root,'app/auth/go'),{recursive:true});
 await writeFile(join(root,'app/auth/go/route.ts'),`
import {NextResponse} from 'next/server';
export function GET(){return NextResponse.redirect(new URL('/account','http://example.com'));}
`);
 const result=await scanProject({root});const converted=await result.convert();
 expect(converted.documentValid).toBe(true);const doc=converted.document as any;
 const sig=doc.paths['/api/webhook'].post.parameters.find((p:any)=>p.name==='stripe-signature');
 expect(sig).toMatchObject({in:'header',required:true});
 expect(Object.keys(doc.paths['/api/webhook'].post.responses).sort()).toEqual(['200','400']);
 const go=doc.paths['/auth/go'].get.responses;
 expect(Object.keys(go)).toEqual(['307']);
 expect(go['307'].content).toBeUndefined();
 }finally{await rm(root,{recursive:true,force:true});}
});

it('jaxrs: Response.ok(field).build() resolves the enclosing class field generic type',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nb5-jaxrs-'));
 try{
 await writeFile(join(root,'LegumeResource.java'),`import java.util.LinkedHashSet;
import java.util.Set;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
@Path("/legumes")
public class LegumeResource {
 private Set<Legume> legumes = new LinkedHashSet<>();
 @GET
 @Produces(MediaType.APPLICATION_JSON)
 public Response list(){return Response.ok(legumes).build();}
}
class Legume {public String name;public String description;}`);
 const result=await scanProject({root});const converted=await result.convert();
 expect(converted.documentValid).toBe(true);const doc=converted.document as any;
 const schema=doc.paths['/legumes'].get.responses['200'].content['application/json'].schema;
 expect(schema.type).toBe('array');
 expect(schema.items.$ref).toBeDefined();
 }finally{await rm(root,{recursive:true,force:true});}
});
