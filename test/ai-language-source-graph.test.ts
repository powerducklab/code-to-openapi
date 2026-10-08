import {expect,it} from 'vitest';
import {createLanguageSourceGraph} from '../src/ai/languageSourceGraph.js';
import {createPythonAnalysis} from '../src/lang/python/index.js';
import {createGoAnalysis} from '../src/lang/go/index.js';
import {createJavaAnalysis} from '../src/lang/java/index.js';
import {createCSharpAnalysis} from '../src/lang/csharp/index.js';
import {createRustAnalysis} from '../src/lang/rust/index.js';
import type {ScanContext} from '../src/core/types.js';
function context(language:string,sources:Record<string,string>):ScanContext {
 const files=Object.entries(sources).map(([path,content])=>({path,content,language,absolutePath:'/tmp/context-fixture/'+path,hash:'',bytes:Buffer.byteLength(content)}));
 return {root:'/tmp/context-fixture',index:{files,byPath:new Map(files.map(f=>[f.path,f]))},manifest:{packages:new Map()},report:()=>{}};
}
it('Python resolves relative modules, module aliases and re-exports without crossing same-named packages',async()=>{
 const python=(await createPythonAnalysis(context('python',{
  'app/api.py':'from . import service\nfrom .models import User as U\nimport external_sdk\ndef handler(): return service.load(U())',
  'app/service.py':'from .types import User\ndef load(user): return user',
  'app/models.py':'from .types import User',
  'app/types.py':'class User: pass',
  'other/models.py':'class User: pass',
 })))!;
 const graph=createLanguageSourceGraph({python});
 expect(graph.edges('app/api.py').local).toEqual(expect.arrayContaining(['app/service.py','app/models.py']));
 expect(graph.edges('app/api.py').local).not.toContain('other/models.py');
 expect(graph.edges('app/models.py').local).toContain('app/types.py');
 expect(graph.edges('app/api.py').missing).toContain('external_sdk');
});
it('Go resolves same-package types and imported package aliases; excludes another package with the same name',async()=>{
 const analysis=(await createGoAnalysis(context('go',{
  'api/handler.go':'package api\nimport model "example.test/project/domain"\nimport unused "example.test/project/unrelated"\nfunc Handle() model.User { return Load() }',
  'api/service.go':'package api\nfunc Load() string { return "ok" }',
  'domain/user.go':'package entities\ntype User struct { Name string }',
  'unrelated/user.go':'package entities\ntype User struct { Secret string }',
 })))!;
 const graph=createLanguageSourceGraph({go:{...analysis,modulePath:'example.test/project'}});
 expect(graph.edges('api/handler.go').local).toEqual(expect.arrayContaining(['api/service.go','domain/user.go']));
 expect(graph.edges('api/handler.go').local).not.toContain('unrelated/user.go');
});
it('Java uses package-qualified explicit and wildcard imports instead of a global type-name match',async()=>{
 const java=(await createJavaAnalysis(context('java',{
  'api/Controller.java':'package api; import domain.User; import services.*; class Controller { Service service; User load() { return service.load(); } }',
  'domain/User.java':'package domain; public record User(String name) {}',
  'services/Service.java':'package services; import domain.User; public class Service { public User load() { return new User("ok"); } }',
  'other/User.java':'package other; public record User(String secret) {}',
 })))!;
 const graph=createLanguageSourceGraph({java});
 expect(graph.edges('api/Controller.java').local).toEqual(expect.arrayContaining(['domain/User.java','services/Service.java']));
 expect(graph.edges('api/Controller.java').local).not.toContain('other/User.java');
});
it('C# retains aliases, global usings and partial declarations while rejecting ambiguous imported types',async()=>{
 const csharp=(await createCSharpAnalysis(context('csharp',{
  'Api.cs':'using U = Domain.User; namespace Api; class Endpoint { U Handle() { return new U(); } }',
  'User.cs':'namespace Domain; public partial class User { public string Name {get;set;} }',
  'User.More.cs':'namespace Domain; public partial class User { public int Age {get;set;} }',
  'Global.cs':'global using Domain;',
  'Other.cs':'namespace Other; class User { public string Secret {get;set;} }',
  'Ambiguous.cs':'using Other; namespace Api; class Ambiguous { User Handle() { return null; } }',
 })))!;
 const graph=createLanguageSourceGraph({csharp});
 expect(graph.edges('Api.cs').local).toEqual(expect.arrayContaining(['User.cs','User.More.cs']));
 expect(graph.edges('Api.cs').local).not.toContain('Other.cs');
 expect(graph.edges('Ambiguous.cs').missing).toContain('ambiguous: User');
});
it('Rust resolves grouped imports and crate/super paths without attaching external crates to the local root',async()=>{
 const rust=(await createRustAnalysis(context('rust',{
  'src/lib.rs':'mod api; mod models; mod service;',
  'src/api/mod.rs':'use crate::models::{User, Payload as Input}; use super::service; use external::Unknown; fn handle() -> User {service::load()}',
  'src/models.rs':'pub struct User { pub name: String } pub struct Payload { pub id: i64 }',
  'src/service.rs':'use crate::models::User; pub fn load()->User { todo!() }',
  'other/src/models.rs':'pub struct User { pub secret: String }',
 })))!;
 const graph=createLanguageSourceGraph({rust});
 expect(graph.edges('src/api/mod.rs').local).toEqual(expect.arrayContaining(['src/models.rs','src/service.rs']));
 expect(graph.edges('src/api/mod.rs').local).not.toContain('other/src/models.rs');
 expect(graph.edges('src/api/mod.rs').local).not.toContain('src/lib.rs');
 expect(graph.edges('src/api/mod.rs').missing).toContain('external::Unknown');
});
it('Java carries candidate service implementations without claiming a verified runtime binding',async()=>{
 const java=(await createJavaAnalysis(context('java',{
  'Service.java':'package app; public interface Service { String load(); }',
  'Impl.java':'package app; public class Impl implements Service { public String load(){return "evidence";} }',
  'Unrelated.java':'package other; public class Unrelated implements Service { public String load(){return "wrong";} }',
 })))!;
 const graph=createLanguageSourceGraph({java});
 expect(graph.edges('Service.java').local).toContain('Impl.java');
 expect(graph.edges('Service.java').local).not.toContain('Unrelated.java');
 expect(graph.edges('Service.java').limitations.some(s=>s.includes('runtime binding'))).toBe(true);
});
it('C# carries local interface implementations and marks dispatch uncertainty',async()=>{
 const csharp=(await createCSharpAnalysis(context('csharp',{
  'IService.cs':'namespace App; public interface IService { string Load(); }',
  'Service.cs':'namespace App; public class Service : IService { public string Load(){return "evidence";} }',
 })))!;
 const graph=createLanguageSourceGraph({csharp});
 expect(graph.edges('IService.cs').local).toContain('Service.cs');
 expect(graph.edges('IService.cs').limitations.some(s=>s.includes('runtime binding'))).toBe(true);
});
it('focused Python context excludes unrelated imports but preserves same-file helper dependencies and class metadata',async()=>{
 const python=(await createPythonAnalysis(context('python',{
  'app/api.py':'from .models import User\nfrom .unused import Other\nfrom .serializers import UserSerializer\ndef helper(): return User()\ndef handler(): return helper()\nclass View:\n serializer_class = UserSerializer\n def get(self): return helper()',
  'app/models.py':'class User: pass',
  'app/unused.py':'class Other: pass',
  'app/serializers.py':'class UserSerializer: pass',
 })))!;
 const graph=createLanguageSourceGraph({python});
 const focused=graph.edges('app/api.py','def handler(): return helper()');
 expect(focused.local).toContain('app/models.py');expect(focused.local).not.toContain('app/unused.py');
 const classMethod=graph.edges('app/api.py','def get(self): return helper()');
 expect(classMethod.local).toEqual(expect.arrayContaining(['app/models.py','app/serializers.py']));
});
