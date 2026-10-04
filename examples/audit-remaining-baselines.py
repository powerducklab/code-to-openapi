# Independent contracts authored from pinned example sources and framework serializers.
# Does not read scanner output.
import json
from pathlib import Path
out=Path(__file__).resolve().parent.parent/'docs/audits/2026-10-04-remaining'
out.mkdir(parents=True, exist_ok=True)
def obj(p,required):return {'type':'object','properties':p,'required':required}
def media(s,m='application/json'):return {'content':{m:{'schema':s}}}
def resp(s,m='application/json'):return {'description':'Source contract',**media(s,m)}
def body(s,m='application/json'):return {'required':True,**media(s,m)}
def param(n,s):return {'name':n,'in':'path','required':True,'schema':s}
string={'type':'string'};integer={'type':'integer'};wide={'type':'integer','format':'int64'}
jreq=obj({'id':{'type':['integer','null'],'format':'int64'},'message':string},['message'])
jresponse=obj({'id':wide,'message':string},['id','message'])
mreq=obj({'id':wide,'message':string},['id','message'])
error=obj({'status':string,'reason':string},['status','reason'])
rocket={'openapi':'3.2.0','info':{'title':'Independent Rocket serialization contract','version':'1'},'paths':{
 '/json/':{'post':{'requestBody':body(jreq),'responses':{'200':resp(obj({'status':string,'id':wide},['status','id']))}}},
 '/json/{id}':{
  'get':{'parameters':[param('id',wide)],'responses':{'200':resp(jresponse),'404':resp(error)}},
  'put':{'parameters':[param('id',wide)],'requestBody':body(jreq),'responses':{'200':resp(obj({'status':string},['status'])),'404':resp(error)}}},
 '/msgpack/':{'post':{'requestBody':body(mreq,'application/msgpack'),'responses':{'200':resp(string,'text/plain')}}},
 '/msgpack/{id}':{'get':{'parameters':[param('id',wide)],'responses':{'200':resp(mreq,'application/msgpack')}}},
 '/people/{id}':{'get':{'parameters':[param('id',{'type':'string','format':'uuid'})],'responses':{'200':resp(string,'text/plain')}}},
}}
nullable={'type':['string','null']}
response=obj({'id':integer,'name':nullable,'age':integer,'phoneNumber':nullable},['id','name','age','phoneNumber'])
request=obj({'id':integer,'firstName':{'type':'string','minLength':1},'lastName':{'type':'string','minLength':1},'age':{'type':'integer','minimum':11},'phoneNumbers':{'type':'array','items':string,'minItems':1}},['firstName','lastName','age','phoneNumbers'])
paths={}
for slug in ['ok','struct','codegen','scoped-validator','throttle']:
 paths['/benchmark/'+slug+'/{id}']={'post':{'parameters':[param('id',integer)],'requestBody':body(request),'responses':{'200':resp(response)}}}
for slug in ['object-request','empty-request']:
 paths['/'+slug]={'get':{'responses':{'200':resp(obj({'message':string},['message']))}}}
for slug in ['command-handler-1','command-handler-2']:
 paths['/'+slug]={'get':{'responses':{'200':resp(obj({},[]))}}}
query=[]
for prefix in ['','nestedQueryObject.','nestedQueryObject.moreNestedQueryObject.']:
 for n,s in {'id':integer,'firstName':nullable,'lastName':nullable,'age':integer,'phoneNumbers':{'type':['array','null'],'items':string}}.items():
  query.append({'name':prefix+n,'in':'query','required':False,'schema':s})
# Nested response graph follows QueryResponse -> NestedQueryObject -> MoreNestedQueryObject.
more=obj({'id':integer,'firstName':nullable,'lastName':nullable,'age':integer,'phoneNumbers':{'type':['array','null'],'items':string}},['id','firstName','lastName','age','phoneNumbers'])
nested=json.loads(json.dumps(more));nested['properties']['moreNestedQueryObject']={'anyOf':[more,{'type':'null'}]};nested['required'].append('moreNestedQueryObject')
qr=json.loads(json.dumps(response));qr['properties']['nestedQueryObject']={'anyOf':[nested,{'type':'null'}]};qr['required'].append('nestedQueryObject')
paths['/benchmark/query-binding']={'get':{'parameters':query,'responses':{'200':resp(qr)}}}
fe={'openapi':'3.2.0','info':{'title':'Independent FastEndpoints benchmark contract','version':'1'},'paths':paths}
for n,d in [('rocket',rocket),('fastendpoints',fe)]: (out/(n+'-baseline.json')).write_text(json.dumps(d,indent=2)+'\n')
