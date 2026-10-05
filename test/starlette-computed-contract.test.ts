import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('infers direct JSON reads and stable string expressions without treating writes as inputs',async()=>{
 const root=await mkdtemp(join(tmpdir(),'starlette-contract-'));
 try{
 await writeFile(join(root,'app.py'),`from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.templating import Jinja2Templates
templates = Jinja2Templates(directory="templates")
app = Starlette()
@app.route('/owned')
async def owned(request):
    def unused():
        return JSONResponse({'secret': True}, status_code=418)
    JSONResponse({'discarded': True}, status_code=409)
    response = JSONResponse({'actual': True}, status_code=201)
    return response
@app.route('/fail')
async def fail(request):
    raise RuntimeError('failed')
@app.route('/html')
async def html(request):
    return templates.TemplateResponse('index.html', {'request':request})
@app.route('/item', methods=['PUT'])
async def item(req):
    body = await req.json()
    name = body['name']
    label = f"hello {name}"
    return JSONResponse({'label':label, 'value':str(name)})
@app.route('/write', methods=['POST'])
async def write(request):
    body = await request.json()
    body['generated'] = 'value'
    return JSONResponse({'ok':True})
`);
 const result=await scanProject({root});const converted=await result.convert();expect(converted.documentValid).toBe(true);
 const doc=converted.document as any;
 expect(Object.keys(doc.paths['/owned'].get.responses)).toEqual(['201']);
 expect(doc.paths['/owned'].get.responses['201'].content['application/json'].schema.properties).toEqual({actual:{type:'boolean'}});
 expect(doc.paths['/fail'].get.responses['200']).toBeUndefined();
 expect(doc.paths['/fail'].get.responses['500']).toBeDefined();
 expect(doc.paths['/fail'].get.responses['500'].content['text/plain; charset=utf-8'].schema).toEqual({type:'string'});
 expect(doc.paths['/html'].get.responses['200'].content['text/html'].schema.type).toBe('string');
 expect(doc.paths['/item'].put.requestBody.content['application/json'].schema).toEqual({type:'object',properties:{name:{}},required:['name']});
 expect(doc.paths['/item'].put.responses['200'].content['application/json'].schema.properties).toEqual({label:{type:'string'},value:{type:'string'}});
 expect(doc.paths['/write'].post.requestBody.content['application/json'].schema.properties?.generated).toBeUndefined();
 }finally{await rm(root,{recursive:true,force:true});}
});
