"""Exercise original running Conduit on loopback with disposable test records.
Combines actual HTTP payloads/statuses with native Swagger request annotations.
Does not use scanner output. Never points at a production host.
"""
import json,sys,time,copy
from pathlib import Path
from urllib.request import Request,urlopen
from urllib.error import HTTPError
base='http://127.0.0.1:18762';out=Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
swagger=json.loads((out/'native-swagger.json').read_text());paths={};events=[];token=None
nonce=str(time.time_ns());user='audit'+nonce;password='Audit-safe-password-0123';slug=None;comment_id=None
def shape(value,key=''):
 if value is None:return {'type':['string','null']}
 if isinstance(value,bool):return {'type':'boolean'}
 if isinstance(value,int):return {'type':'integer'}
 if isinstance(value,str):return {'type':'string',**({'format':'date-time'} if key in ['createdAt','updatedAt'] else {})}
 if isinstance(value,list):return {'type':'array','items':shape(value[0]) if value else {}}
 return {'type':'object','properties':{k:shape(v,k) for k,v in value.items()},'required':list(value)}
def request(method,path,data=None,template=None,expect=None,record=True):
 headers={'Accept':'application/json'}
 if token:headers['Authorization']='Token '+token
 if data is not None:headers['Content-Type']='application/json'
 req=Request(base+path,data=json.dumps(data).encode() if data is not None else None,headers=headers,method=method.upper())
 try:response=urlopen(req,timeout=15)
 except HTTPError as e:response=e
 raw=response.read();status=response.status;media=response.headers.get_content_type();payload=json.loads(raw) if raw and media=='application/json' else None
 events.append({'method':method,'path':template or path,'status':status,'media':media,'fields':list(payload) if isinstance(payload,dict) else None})
 if expect is not None:assert status==expect,(method,path,status,payload)
 if record:
  source=copy.deepcopy(swagger['paths'].get(template or path,{}).get(method,{}));operation={'responses':{str(status):{'description':'Observed native HTTP response',**({'content':{media:{'schema':shape(payload)}}} if payload is not None else {})}}}
  if 'parameters' in source:operation['parameters']=source['parameters']
  if 'requestBody' in source:
   b=source['requestBody'];b['content']={m:v for m,v in b['content'].items() if m=='application/json'};operation['requestBody']=b
  paths.setdefault(template or path,{})[method]=operation
 return payload
request('post','/api/users',{'user':{'username':user,'email':user+'@example.test','password':password}},expect=201)
login=request('post','/api/users/login',{'user':{'email':user+'@example.test','password':password}},expect=200);token=login['user']['token']
request('get','/api/user',expect=200)
request('put','/api/user',{'user':{'bio':'oracle bio'}},expect=200)
request('get','/api/profiles/'+user,template='/api/profiles/{username}',expect=200)
request('post','/api/profiles/'+user+'/follow',template='/api/profiles/{username}/follow',expect=200)
request('delete','/api/profiles/'+user+'/follow',template='/api/profiles/{username}/follow',expect=200)
a=request('post','/api/articles',{'article':{'title':'Oracle '+nonce,'description':'desc','body':'body','tagList':['audit']}},expect=201);slug=a['article']['slug']
request('get','/api/articles/'+slug,template='/api/articles/{slug}',expect=200)
request('put','/api/articles/'+slug,{'article':{'body':'updated'}},template='/api/articles/{slug}',expect=200)
request('get','/api/articles',expect=200);request('get','/api/articles/feed',expect=200);request('get','/api/tags',expect=200)
request('post','/api/articles/'+slug+'/favorite',template='/api/articles/{slug}/favorite',expect=200)
request('delete','/api/articles/'+slug+'/favorite',template='/api/articles/{slug}/favorite',expect=200)
c=request('post','/api/articles/'+slug+'/comments',{'comment':{'body':'comment'}},template='/api/articles/{slug}/comments',expect=201);comment_id=c['comment']['id']
request('get','/api/articles/'+slug+'/comments',template='/api/articles/{slug}/comments',expect=200)
request('delete',f'/api/articles/{slug}/comments/{comment_id}',template='/api/articles/{slug}/comments/{id}',expect=204)
request('delete','/api/articles/'+slug,template='/api/articles/{slug}',expect=204)
request('post','/api/users',{'user':{'username':user+'invalid','email':user+'invalid@example.test','password':'short'}},expect=422,record=False)
# Token and literal business values are intentionally not persisted.
(out/'baseline.json').write_text(json.dumps({'openapi':'3.2.0','info':{'title':'Native Conduit HTTP baseline','version':'1'},'paths':paths,'components':swagger['components']},indent=2)+'\n')
(out/'http-evidence.json').write_text(json.dumps(events,indent=2)+'\n');print(len(paths),'paths,',len(events),'HTTP probes')
