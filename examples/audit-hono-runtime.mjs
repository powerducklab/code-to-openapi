/** Independent oracle: original upstream route definitions and Zod schemas.
 * Handler bodies, database and auth middleware are NOT executed. */
import {build} from 'esbuild';
import {writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
const [rootArg,depsArg,destination]=process.argv.slice(2);
const root=resolve(rootArg),deps=resolve(depsArg);
if(execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!=='4dc311ebdaeaa1cbffbb5608fae7d33f5baa9208')throw Error('Unexpected upstream revision');
const dir=mkdtempSync(join(tmpdir(),'hono-oracle-'));
try {
 const code=`import {OpenAPIHono} from '@hono/zod-openapi';
import * as routes from ${JSON.stringify(join(root,'src/users/users.routes.ts'))};
const app=new OpenAPIHono();
// Mounts manually transcribed from original core/app.ts and controllers.
for(const [prefix,names] of [['/users',['login','register']],['/user',['getCurrentUser','updateUser']],['/profiles',['getProfile','followUser','unfollowUser']]]){
 const child=new OpenAPIHono();
 for(const name of names)child.openapi(routes[name],c=>c.json({oracle:true}));
 app.route(prefix,child);
}
const absent=await app.request('/users/login',{method:'POST'});
if(absent.status!==200)throw Error('Unexpected optional-body behavior');
const invalid=await app.request('/users/login',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
if(invalid.status!==400)throw Error('Invalid supplied body was not validated');
console.log(JSON.stringify(app.getOpenAPI31Document({openapi:'3.1.0',info:{title:'Independent upstream contract',version:'1'}}),null,2));`;
 const file=join(dir,'oracle.mjs');
 await build({stdin:{contents:code,resolveDir:root,loader:'ts'},bundle:true,platform:'node',format:'esm',outfile:file,tsconfig:join(root,'tsconfig.json'),nodePaths:[join(deps,'node_modules')]});
 const spec=JSON.parse(execFileSync(process.execPath,[file],{encoding:'utf8',maxBuffer:10*1024*1024}));
 writeFileSync(destination,JSON.stringify(spec,null,2)+'\n');
 console.log(JSON.stringify({paths:Object.keys(spec.paths).length}));
}finally{rmSync(dir,{recursive:true,force:true});}
