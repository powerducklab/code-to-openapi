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

it('infers schema-less table gateway rows, nullable reads and open inserts without fabricating value types',async()=>{
 const root=await mkdtemp(join(tmpdir(),'starlette-gateway-'));
 try{
 await writeFile(join(root,'app.py'),`from starlette.applications import Starlette
from starlette.responses import JSONResponse
app = Starlette()
db = connect('sqlite:///app.db')
@app.route('/widgets')
async def list_widgets(request):
    table = db['widgets']
    return JSONResponse(table.find())
@app.route('/widgets', methods=['POST'])
async def create_widget(request):
    payload = await request.json()
    payload['createdAt'] = 1
    db['widgets'].insert(payload)
    return JSONResponse({'created': 'ok'})
@app.route('/widgets/{wid}')
async def get_widget(request):
    row = db['widgets'].find_one(id=request.path_params['wid'])
    return JSONResponse(row)
@app.route('/widgets/{wid}', methods=['PUT'])
async def update_widget(request):
    body = await request.json()
    data = dict(id=body['id'], name=body['name'], count=body['count'])
    db['widgets'].update(data, ['id'])
    return JSONResponse(db['widgets'].find_one(id=body['id']))
`);
 const result=await scanProject({root});
 const doc=(await result.convert()).document as any;
 const list=doc.paths['/widgets'].get.responses['200'].content['application/json'].schema;
 expect(list.type).toBe('array');
 expect(Object.keys(list.items.properties).sort()).toEqual(['count','id','name']);
 // Column names are provable from the authoritative write dict; value types
 // are not statically provable from an unconstrained request.json body, so
 // they must stay open holes rather than fabricated primitives.
 expect(list.items.properties.id).toEqual({});
 // Verbatim insert of the decoded body keeps the row open to extra keys.
 expect(list.items.additionalProperties).toEqual({});
 const detail=doc.paths['/widgets/{wid}'].get.responses['200'].content['application/json'].schema;
 expect(detail.anyOf?.[1]).toEqual({type:'null'});
 expect(Object.keys(detail.anyOf[0].properties).sort()).toEqual(['count','id','name']);
 const postBody=doc.paths['/widgets'].post.requestBody.content['application/json'].schema;
 expect(postBody).toEqual({type:'object',additionalProperties:{}});
 const putBody=doc.paths['/widgets/{wid}'].put.requestBody.content['application/json'].schema;
 expect(putBody.properties.id).toEqual({});
 expect(putBody.required.slice().sort()).toEqual(['count','id','name']);
 expect(putBody.additionalProperties).toBeUndefined();
 }finally{await rm(root,{recursive:true,force:true});}
});
