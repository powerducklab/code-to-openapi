import {sourceFocus,sourceNames,focusedSourceNames} from './sourceFocus.js';
import { posix as path } from 'node:path';
import type { PythonAnalysis } from '../lang/python/index.js';
import { goTypeDeclaration, resolveGoCall } from '../lang/go/symbols.js';
import type { GoAnalysis } from '../lang/go/index.js';
import type { JavaAnalysis } from '../lang/java/index.js';
import type { CSharpAnalysis } from '../lang/csharp/index.js';
import type { RustAnalysis } from '../lang/rust/index.js';
import type { TsNode } from '../lang/treesitter/runtime.js';
import { findAll } from '../lang/treesitter/ast.js';

export interface AdditionalSourceAnalyses {
  python?: PythonAnalysis;
  go?: GoAnalysis;
  java?: JavaAnalysis;
  csharp?: CSharpAnalysis;
  rust?: RustAnalysis;
}
export interface SourceEdges { local: string[]; missing: string[]; limitations: string[] }
const namespace = (node: TsNode): string => {
  const parts: string[] = [];
  for (let current: TsNode | null = node; current; current = current.parent) {
    if (['namespace_declaration','file_scoped_namespace_declaration'].includes(current.type)) {
      const name = current.childForFieldName('name')?.text;
      if (name) parts.unshift(name);
    }
    if (!current.parent && !parts.length) {
      const name = current.namedChildren.find(n => n.type === 'file_scoped_namespace_declaration')?.childForFieldName('name')?.text;
      if (name) parts.push(name);
    }
  }
  return parts.join('.');
};

/** Language scoping, not framework or repository names, determines dependency identity. */
export function createLanguageSourceGraph(analyses: AdditionalSourceAnalyses) {
  const roots = new Map<string, TsNode>();
  for (const analysis of Object.values(analyses)) for (const file of analysis?.files.values() ?? []) roots.set(file.path,file.root);
  const cache = new Map<string, SourceEdges>();
  const csTypes = new Map<string, Set<string>>();
  for (const file of analyses.csharp?.files.values() ?? []) {
    for (const node of findAll(file.root,n => ['class_declaration','interface_declaration','record_declaration','struct_declaration','enum_declaration'].includes(n.type))) {
      const name = node.childForFieldName('name')?.text;
      if (!name) continue;
      const enclosing: string[] = [];
      for (let owner=node.parent;owner;owner=owner.parent) if (['class_declaration','struct_declaration','record_declaration'].includes(owner.type)) enclosing.unshift(owner.childForFieldName('name')?.text ?? '');
      const key = [namespace(node),...enclosing,name].filter(Boolean).join('.');
      const files = csTypes.get(key) ?? new Set<string>();files.add(file.path);csTypes.set(key,files);
    }
  }
  const globalUsings = [...(analyses.csharp?.files.values() ?? [])].flatMap(file =>
    findAll(file.root,n => n.type==='using_directive' && /^global\s+using\b/.test(n.text)));
  const javaImplementations = new Map<string,Set<string>>();
  for (const def of analyses.java?.typesByFqn.values() ?? []) {
    const table=analyses.java!.imports.get(def.file);
    for (const node of findAll(def.node.childForFieldName('interfaces') ?? def.node.childForFieldName('superclass') ?? def.node,
      n=>n.type==='type_identifier')) {
      // Only declared inheritance clauses establish implementation provenance.
      let owner=node.parent;
      while(owner&&owner.id!==def.node.id&&!['super_interfaces','superclass'].includes(owner.type))owner=owner.parent;
      if(!owner||owner.id===def.node.id)continue;
      const imported=table?.explicit.get(node.text);
      const keys=imported?[imported]:[[def.packageName,node.text].filter(Boolean).join('.'),...(table?.wildcards??[]).map(pkg=>pkg+'.'+node.text)];
      const found=keys.filter(key=>analyses.java!.typesByFqn.has(key));
      if(found.length===1){const files=javaImplementations.get(found[0]!)??new Set<string>();files.add(def.file);javaImplementations.set(found[0]!,files);}
    }
  }
  const csImplementations = new Map<string,Set<string>>();
  for (const file of analyses.csharp?.files.values() ?? []) {
    const uses=[...findAll(file.root,n=>n.type==='using_directive'),...globalUsings].map(n=>n.text.replace(/^(?:global\s+)?using\s+/,'').replace(/;$/,'').trim());
    for(const cls of findAll(file.root,n=>['class_declaration','record_declaration','struct_declaration'].includes(n.type))){
      const base=cls.namedChildren.find(n=>n.type==='base_list');
      for(const node of base?.namedChildren??[]){
        const name=node.type==='generic_name'?node.namedChildren[0]?.text:node.text;
        if(!name)continue;
        const keys=[name,[namespace(cls),name].filter(Boolean).join('.'),...uses.map(pkg=>pkg+'.'+name)].filter(key=>csTypes.has(key));
        const found=[...new Set(keys)];
        if(found.length===1){const files=csImplementations.get(found[0]!)??new Set<string>();files.add(file.path);csImplementations.set(found[0]!,files);}
      }
    }
  }
  const goDefs = new Map<string, Set<string>>();
  for (const file of analyses.go?.files.values() ?? []) {
    for (const node of findAll(file.root,n => ['type_spec','function_declaration','method_declaration','var_spec','const_spec'].includes(n.type))) {
      const names = node.type.endsWith('_spec') && node.type!=='type_spec'
        ? node.namedChildren.filter(n=>n.type==='identifier') : [node.childForFieldName('name')].filter((n):n is TsNode=>!!n);
      for (const name of names) {
        const key = `${path.dirname(file.path)}\0${file.packageName}\0${name.text}`;
        const files=goDefs.get(key)??new Set<string>();files.add(file.path);goDefs.set(key,files);
      }
    }
  }
  const pythonModule = (owner: string, module: string): string[] => {
    const count = module.match(/^\.+/)?.[0].length ?? 0;
    const parent = path.dirname(owner).split('/').filter(s=>s!=='.');
    if(count>parent.length+1)return [];
    const suffix = module.slice(count).split('.').filter(Boolean);
    const base = (count ? [...parent.slice(0,parent.length-count+1),...suffix] : suffix).join('/');
    const candidates = [`${base}.py`,`${base ? base+'/' : ''}__init__.py`];
    const exact = candidates.filter(file=>analyses.python?.files.has(file));
    if(exact.length || count)return exact;
    return [...(analyses.python?.files.keys() ?? [])].filter(file=>candidates.some(candidate=>file.endsWith('/'+candidate)));
  };
  const rustModule = (owner: string, parts: string[]): string[] => {
    // Resolve within the nearest crate source directory; never match a global short name.
    const segments=owner.split('/'), src=segments.lastIndexOf('src');
    const crate=src>=0?segments.slice(0,src+1):[];
    let base=path.basename(owner)==='mod.rs'||['lib.rs','main.rs'].includes(path.basename(owner))
      ? path.dirname(owner).split('/').filter(s=>s!=='.') : owner.replace(/\.rs$/,'').split('/');
    const rest=[...parts];
    if(rest[0]==='crate'){base=crate;rest.shift();}
    else if(rest[0]==='self')rest.shift();
    else if(rest[0]!=='super')base=crate;
    while(rest[0]==='super'){base.pop();rest.shift();}
    for(let length=rest.length;length>=(rest.length ? 1 : 0);length--){
      const joined=[...base,...rest.slice(0,length)].join('/');
      const candidates=[`${joined}.rs`,`${joined}/mod.rs`,...(length===0&&base.join('/')===crate.join('/')?[`${joined}/lib.rs`,`${joined}/main.rs`]:[])];
      const found=candidates.filter(file=>analyses.rust?.files.has(file));
      if(found.length)return found;
    }
    return [];
  };
  return {
    roots,
    edges(file: string, handler?:string): SourceEdges {
      const cacheKey=file+"\0"+(handler??"");
      const cached=cache.get(cacheKey);if(cached)return cached;
      const local=new Set<string>(),missing=new Set<string>(),limitations=new Set<string>();
      const addUnique=(targets:string[],reference:string,allowMany=false)=>{
        const unique=[...new Set(targets)];
        if(unique.length===1||allowMany&&unique.length)unique.forEach(target=>{if(target!==file)local.add(target);});
        else missing.add(`${unique.length?'ambiguous: ':''}${reference}`);
      };
      const py=analyses.python?.files.get(file);
      if(py){
        const used=focusedSourceNames(py.root,handler);
        for(const statement of findAll(py.root,n=>n.type==='import_statement'||n.type==='import_from_statement')){
          if(statement.type==='import_statement'){
            for(const child of statement.namedChildren){const module=child.type==='aliased_import'?child.childForFieldName('name')?.text:child.text;const binding=child.childForFieldName('alias')?.text??module?.split('.')[0];if(module&&(!handler||!binding||used.has(binding)))addUnique(pythonModule(file,module),module);}
          }else{
            const module=statement.childForFieldName('module_name')?.text??statement.namedChildren[0]?.text??'';
            for(const child of statement.namedChildren.slice(1)){
              const name=child.type==='aliased_import'?child.childForFieldName('name')?.text:child.text;
              const binding=child.childForFieldName('alias')?.text??name;
              if(handler&&binding&&binding!=='*'&&!used.has(binding))continue;
              const submodule=pythonModule(file,module+(module.endsWith('.')?'':'.')+name);
              addUnique(submodule.length?submodule:pythonModule(file,module),`${module}:${name}`);
              if(child.type==='wildcard_import')limitations.add('Python wildcard imports require checking exported names.');
            }
          }
        }
        if(findAll(py.root,n=>n.type==='call'&&/^(?:__import__|importlib\.import_module)\s*\(/.test(n.text)).length)limitations.add('Dynamic Python imports are not resolved.');
      }
      const go=analyses.go?.files.get(file);
      if(go){
        const focus=sourceFocus(go.root,handler);
        const names=new Set(findAll(focus,n=>['identifier','type_identifier'].includes(n.type)&&!['qualified_type','selector_expression'].includes(n.parent?.type??'')).map(n=>n.text));
        for(const node of findAll(focus,n=>n.type==='call_expression'||n.type==='qualified_type'||n.type==='type_identifier')){
          const target=node.type==='call_expression'?resolveGoCall(node,analyses.go!):goTypeDeclaration(node,analyses.go!);
          const targetFile=target&&('file' in target)?(typeof target.file==='string'?target.file:target.file.path):undefined;
          if(targetFile&&targetFile!==file)local.add(targetFile);
        }
        const samePackage={dir:path.dirname(file),name:go.packageName,names};
        const packages=[samePackage];
        for(const spec of findAll(go.root,n=>n.type==='import_spec')){
          const imported=(spec.childForFieldName('path')?.text??'').replace(/^["`]|["`]$/g,'');
          const module=analyses.go!.modulePath;
          const dir=module&&imported===module?'.':module&&imported.startsWith(module+'/')?imported.slice(module.length+1):undefined;
          const targets=[...(analyses.go!.files.values())].filter(f=>path.dirname(f.path)===dir);
          if(!targets.length){missing.add(imported);continue;}
          const alias=spec.childForFieldName('name')?.text;
          if(alias==='_'){limitations.add(`Side-effect import ${imported} is not expanded.`);continue;}
          for(const name of new Set(targets.map(f=>f.packageName))){
            const binding=alias??name;
            const used=binding==='.'?names:new Set(findAll(focus,n=>
              (n.type==='qualified_type'&&n.childForFieldName('package')?.text===binding)||
              (n.type==='selector_expression'&&n.childForFieldName('operand')?.text===binding)
            ).map(n=>(n.childForFieldName('name')??n.childForFieldName('field'))?.text).filter((n):n is string=>!!n));
            packages.push({dir:dir!,name,names:used});
            if(binding==='.')limitations.add(`Dot import ${imported} may introduce ambiguous bindings.`);
          }
        }
        for(const pkg of packages)for(const name of pkg.names)for(const target of goDefs.get(`${pkg.dir}\0${pkg.name}\0${name}`)??[])if(target!==file)local.add(target);
        if(findAll(go.root,n=>n.type==='build_constraint').length)limitations.add('Go build constraints are included as source, not evaluated.');
      }
      const java=analyses.java?.files.get(file);
      if(java){
        const table=analyses.java!.imports.get(file);
        const names=new Set(findAll(sourceFocus(java.root,handler),n=>['type_identifier','scoped_type_identifier','identifier'].includes(n.type)).map(n=>n.text));
        for(const name of names){
          const imported=table?.explicit.get(name);
          const same=analyses.java!.typesByFqn.get([java.packageName,name].filter(Boolean).join('.'));
          const exact=analyses.java!.typesByFqn.get(name);
          const defs=imported?[analyses.java!.typesByFqn.get(imported)]:same?[same]:exact?[exact]:(table?.wildcards??[]).map(pkg=>analyses.java!.typesByFqn.get(pkg+'.'+name));
          const found=defs.filter((def):def is NonNullable<typeof def>=>!!def);
          if(found.length)addUnique(found.map(def=>def.file),name);
          else if(imported)missing.add(imported);
        }
        for(const [fqn,def] of analyses.java!.typesByFqn)if(def.file===file&&javaImplementations.has(fqn)){
          for(const target of javaImplementations.get(fqn)!)if(target!==file)local.add(target);
          limitations.add(`Implementation candidates for ${fqn} are included; runtime binding is not verified.`);
        }
        for(const imp of java.root.namedChildren.filter(n=>n.type==='import_declaration'&&/\bstatic\b/.test(n.text))){
          const qualified=imp.text.replace(/^import\s+static\s+/,'').replace(/;$/,'').trim().split('.');qualified.pop();
          const def=analyses.java!.typesByFqn.get(qualified.join('.'));addUnique(def?[def.file]:[],imp.text);
        }
      }
      const cs=analyses.csharp?.files.get(file);
      if(cs){
        const usings=[...findAll(cs.root,n=>n.type==='using_directive'),...globalUsings];
        const imports:string[]=[],aliases=new Map<string,string>();
        for(const use of usings){
          const text=use.text.replace(/^(?:global\s+)?using\s+(?:static\s+)?/,'').replace(/;$/,'').trim();
          const pair=text.split('=').map(s=>s.trim());if(pair.length===2)aliases.set(pair[0]!,pair[1]!);else imports.push(text);
        }
        for(const node of findAll(sourceFocus(cs.root,handler),n=>n.type==='identifier'||n.type==='qualified_name')){
          const name=node.text,alias=aliases.get(name),own=namespace(node);
          const exact=csTypes.get(alias??name),same=csTypes.get([own,name].filter(Boolean).join('.'));
          const keys=exact?[alias??name]:same?[[own,name].filter(Boolean).join('.')]:imports.map(pkg=>pkg+'.'+name).filter(key=>csTypes.has(key));
          if(keys.length===1)addUnique([...(csTypes.get(keys[0]!)??[])],keys[0]!,true); // partial declarations
          else if(keys.length>1)missing.add(`ambiguous: ${name}`);
          else if(alias)missing.add(alias);
        }
        for(const [fqn,files] of csTypes)if(files.has(file)&&csImplementations.has(fqn)){
          for(const target of csImplementations.get(fqn)!)if(target!==file)local.add(target);
          limitations.add(`Implementation candidates for ${fqn} are included; runtime binding is not verified.`);
        }
        for(const imported of imports)if(![...csTypes.keys()].some(key=>key===imported||key.startsWith(imported+'.')))missing.add(imported);
        if(findAll(cs.root,n=>n.type==='preproc_if').length)limitations.add('C# conditional compilation is not evaluated.');
      }
      const rust=analyses.rust?.files.get(file);
      if(rust){
        const focus=sourceFocus(rust.root,handler),used=focusedSourceNames(rust.root,handler);
        const paths:string[][]=[];
        const usePaths=(node:TsNode,prefix:string[]=[],aliasUsed=false)=>{
          if(node.type==='use_as_clause'){if(handler&&!used.has(node.childForFieldName('alias')?.text??''))return;const p=node.childForFieldName('path')??node.namedChildren[0];if(p)usePaths(p,prefix,true);}
          else if(node.type==='scoped_use_list'){
            const p=node.childForFieldName('path');const next=[...prefix,...(p?.text.split('::')??[])];
            for(const child of node.childForFieldName('list')?.namedChildren??[])usePaths(child,next);
          }else if(node.type==='use_list'){for(const child of node.namedChildren)usePaths(child,prefix);}
          else if(!handler||aliasUsed||node.text.includes('*')||used.has(node.text.split('::').at(-1)!))paths.push([...prefix,...node.text.split('::')]);
        };
        for(const use of findAll(rust.root,n=>n.type==='use_declaration')){const arg=use.childForFieldName('argument')??use.namedChildren.at(-1);if(arg)usePaths(arg);}
        for(const node of findAll(focus,n=>n.type==='scoped_identifier'||n.type==='scoped_type_identifier'))if(/^(crate|self|super)::/.test(node.text))paths.push(node.text.split('::'));
        const declaredModules=new Set(findAll(rust.root,n=>n.type==='mod_item').map(n=>n.childForFieldName('name')?.text));
        for(const node of findAll(focus,n=>n.type==='scoped_identifier'||n.type==='scoped_type_identifier')){
          const parts=node.text.split('::');
          if(declaredModules.has(parts[0]))paths.push(['self',...parts]);
        }
        for(const parts of paths){
          const targets=rustModule(file,parts);
          addUnique(targets,parts.join('::'));
          if(parts.includes('*'))limitations.add('Rust glob imports require checking exported names.');
        }
        if(findAll(rust.root,n=>n.type==='macro_invocation').length)limitations.add('Rust macro-generated dependencies are not expanded.');
      }
      const result={local:[...local],missing:[...missing],limitations:[...limitations]};cache.set(cacheKey,result);return result;
    },
  };
}
