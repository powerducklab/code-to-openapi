const fs=require('fs'),path=require('path'),vm=require('vm');
// Only for the pinned, reviewed realworld fixture. VM is not a security sandbox.
const root=path.resolve(process.argv[2], 'lib/routes');
const S=require(path.resolve(process.argv[3]));
const cache=new Map();
function schema(file){
 file=path.resolve(file);if(!file.startsWith(root+'/')||!file.endsWith('/schema.js'))throw Error('Unexpected oracle import '+file);
 if(cache.has(file))return cache.get(file);
 const module={exports:{}};cache.set(file,module.exports);
 new vm.Script(fs.readFileSync(file,'utf8'),{filename:file}).runInNewContext({module,exports:module.exports,require:(name)=>name==='fluent-json-schema'?S:schema(path.resolve(path.dirname(file),name+'.js'))},{timeout:1000});
 cache.set(file,module.exports);return module.exports;
}
const records=[];
for(const dir of fs.readdirSync(root)){
 const file=path.join(root,dir,'index.js');if(!fs.existsSync(file))continue;
 const text=fs.readFileSync(file,'utf8');const definitions=schema(path.join(root,dir,'schema.js'));
 for(const m of text.matchAll(/method:\s*'([^']+)'[\s\S]*?path:\s*options.prefix\s*\+\s*'([^']+)'[\s\S]*?schema:\s*schema\.([\w]+)/g)){
 const val=definitions[m[3]];const record={method:m[1].toLowerCase(),path:'/'+m[2].replace(/:([\w]+)/g,'{$1}'),source:dir+'/schema.js',binding:m[3]};
 if(!val){record.sourceError='Referenced schema export is absent';records.push(record);continue;}
 record.schema=JSON.parse(JSON.stringify(val,(_,v)=>v&&typeof v.valueOf==='function'&&v.isFluentSchema?v.valueOf():v)); records.push(record);
 }
}
fs.writeFileSync(process.argv[4],JSON.stringify(records,null,2));
