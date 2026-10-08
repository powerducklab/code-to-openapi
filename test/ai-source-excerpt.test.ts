import {expect,it} from 'vitest';
import {sourceExcerpt} from '../src/ai/sourceExcerpt.js';
import {parseSource} from '../src/lang/treesitter/runtime.js';
it('retains a late dependency method with line provenance and strict budget',async()=>{
 const content=`package demo; class Service {\n${'// padding\n'.repeat(1000)}public String load() { return "needed-evidence"; }\n}`;
 const root=await parseSource('java',content);
 const result=sourceExcerpt(content,1800,undefined,new Set(['load']),root);
 expect(result.source).toContain('needed-evidence');expect(result.source.length).toBeLessThanOrEqual(1800);
 expect(result.ranges.some(r=>r.startLine>1000)).toBe(true);expect(result.truncated).toBe(true);
});
it('never exceeds tiny remaining budgets and never invents source from normalized AST offsets',async()=>{
 const original='// original\n'+ 'x'.repeat(100);
 const root=await parseSource('c_sharp','class Modified { public string Handle() { return "transformed"; } }');
 const result=sourceExcerpt(original,10,'not in original',new Set(['Handle']),root);
 expect(result.source.length).toBeLessThanOrEqual(10);expect(result.source).not.toContain('transformed');
});
it('locates a cross-file handler despite the framework truncation marker',async()=>{
 const {createSourceContextBuilder}=await import('../src/ai/sourceContext.js');
 const handler='function handle() {\n'+'x();\n'.repeat(2000)+'}';
 const files=[['routes.js','register(handle);'],['handler.js',handler]].map(([path,content])=>({path:path!,content:content!,absolutePath:'/tmp/'+path,hash:'',bytes:content!.length,language:'javascript'}));
 const build=createSourceContextBuilder({files,byPath:new Map(files.map(f=>[f.path,f]))});
 const result=build({origin:{file:'routes.js',line:1},handlerSource:handler.slice(0,8192)+'\n// ... truncated'} as any);
 expect(result.files[0]?.file).toBe('handler.js');
 expect(result.limitations?.some(s=>s.includes('owner could not'))).toBe(false);
 expect(result.limitations?.some(s=>s.includes('later branches'))).toBe(true);
});
it('invalidates AI cache when an omitted portion of a dependency changes',async()=>{
 const {gapCacheKey}=await import('../src/ai/gapResolver.js');
 const request:any={route:{method:'get',path:'/x'},origin:{file:'a.ts'},gaps:[],handlerSource:'handler',known:{},sourceContext:{files:[{file:'dependency.ts',contentHash:'first',source:'same excerpt',truncated:true}],unavailable:[],truncated:true}};
 const changed=structuredClone(request);changed.sourceContext.files[0].contentHash='second';
 expect(gapCacheKey(request,'v')).not.toBe(gapCacheKey(changed,'v'));
});
