import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('follows service query and actual response mappings, excluding nested function returns',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nest-flow-'));
 try {
 await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{'@nestjs/common':'*'}}));
 await writeFile(join(root,'service.ts'),`interface Declared { user:{name:string;token:string} }
export class Service {
 list(query:any):Declared{const filter=query; if(filter.tag){}; const user={id:42,name:'sample',token:this.sign()}; return {user};}
 sign():string{return externalSign();}
};`);
 await writeFile(join(root,'app.ts'),`import {Controller,Get,Query} from '@nestjs/common';import {Service} from './service';
@Controller('api')class App{
 constructor(private service:Service){}
 @Get()get(@Query()query){const ignored=()=>({wrong:123});return this.service.list(query);}
 @Get('hello')hello(){return 'Hello';}
}`);
 const result=await scanProject({root});const {document,documentValid}=await result.convert();const doc=document as any;
 expect(documentValid).toBe(true);
 expect(doc.paths['/api'].get.parameters).toContainEqual(expect.objectContaining({name:'tag',in:'query',schema:{type:'string'}}));
 const schema=doc.paths['/api'].get.responses['200'].content['application/json'].schema;
 expect(schema.properties.user.properties).toMatchObject({id:{type:'integer',const:42},name:{type:'string'},token:{type:'string'}});
 expect(schema.properties.wrong).toBeUndefined();
 expect(doc.paths['/api/hello'].get.responses['200'].content['text/html'].schema.type).toBe('string');
 }finally{await rm(root,{recursive:true,force:true});}
});
