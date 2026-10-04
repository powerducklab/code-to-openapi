/** Execute original ArkType DTOs. Route bindings are manually transcribed from
 * pinned controllers. Does not run business services or a database. */
import {build} from 'esbuild';
import {writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
const [rootArg,depsArg,destination]=process.argv.slice(2);
const root=resolve(rootArg),deps=resolve(depsArg);
if(execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!=='f642e24f8703cf61c66890dda4979fc55f442a4e')throw Error('Unexpected revision');
const dir=mkdtempSync(join(tmpdir(),'elysia-oracle-'));
try {
 const imports=['users','articles','comments','profiles','tags'].map(name=>`import * as ${name} from ${JSON.stringify(join(root,'src',name,'dto/index.ts'))};`).join('\n');
 const source=`${imports}
import {type} from 'arktype';
const paths={};
const schema=t=>t.toJsonSchema({fallback:ctx=>ctx.base});
function add(method,path,response,body,status=200,query){
 const parameters=[...path.matchAll(/\\{([^}]+)\\}/g)].map(m=>({name:m[1],in:'path',required:true,schema:{type:'string'}}));
 if(query){const q=schema(query);for(const [name,value] of Object.entries(q.properties))parameters.push({name,in:'query',required:(q.required??[]).includes(name),schema:value});}
 const op={parameters,responses:{[status]:{description:'Original DTO contract',...(response?{content:{'application/json':{schema:schema(response)}}}:{})}}};
 if(body)op.requestBody={required:true,content:{'application/json':{schema:schema(body)}}};
 (paths['/api'+path]??={})[method]=op;
}
add('post','/users',users.UserResponseDto,users.CreateUserDto,201);
add('post','/users/login',users.UserResponseDto,users.LoginUserDto);
add('get','/user',users.UserResponseDto);
add('put','/user',users.UserResponseDto,users.UpdateUserDto);
add('get','/profiles/{username}',profiles.profileResponseSchema);
add('post','/profiles/{username}/follow',profiles.profileResponseSchema);
add('delete','/profiles/{username}/follow',profiles.profileResponseSchema);
add('get','/articles',articles.ArticlesResponseDto,null,200,articles.ListArticlesQueryDto);
add('get','/articles/feed',articles.ArticlesResponseDto,null,200,articles.ArticleFeedQueryDto);
add('get','/articles/{slug}',articles.ArticleResponseDto);
add('post','/articles',articles.ArticleResponseDto,articles.CreateArticleDto,201);
add('put','/articles/{slug}',articles.ArticleResponseDto,articles.UpdateArticleDto);
add('delete','/articles/{slug}',null,null,204);
add('post','/articles/{slug}/favorite',articles.ArticleResponseDto);
add('delete','/articles/{slug}/favorite',articles.ArticleResponseDto);
add('get','/articles/{slug}/comments',comments.CommentsResponseDto);
add('post','/articles/{slug}/comments',comments.CommentResponseDto,comments.CreateCommentDto,201);
paths['/api/articles/{slug}/comments'].post.responses['401']={description:'Declared unauthorized error',content:{'application/json':{schema:schema(type({errors:'Record<string, string[]>'}))}}};
add('delete','/articles/{slug}/comments/{id}',null,null,204);
paths['/api/articles/{slug}/comments/{id}'].delete.parameters[1].schema=schema(type('string.numeric.parse'));
add('get','/tags',tags.TagsResponseDto);
// Actual native DTO validation: optional update fields, constrained registration.
if(!users.UpdateUserDto.allows({user:{}}))throw Error('Partial update not optional');
if(users.CreateUserDto.allows({user:{email:'bad',password:'x',username:'x'}}))throw Error('Invalid registration accepted');
console.log(JSON.stringify({openapi:'3.1.0',info:{title:'Independent ArkType contract',version:'1'},paths},null,2));`;
 const file=join(dir,'oracle.mjs');
 await build({stdin:{contents:source,resolveDir:root,loader:'ts'},bundle:true,platform:'node',format:'esm',outfile:file,tsconfig:join(root,'tsconfig.json'),nodePaths:[join(deps,'node_modules')]});
 const spec=JSON.parse(execFileSync(process.execPath,[file],{encoding:'utf8',maxBuffer:20*1024*1024}));
 writeFileSync(destination,JSON.stringify(spec,null,2)+'\n');
 console.log(JSON.stringify({paths:Object.keys(spec.paths).length}));
}finally{rmSync(dir,{recursive:true,force:true});}
