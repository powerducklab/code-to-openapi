"""Exercise the original Petclinic HTTP app backed by its isolated H2 database.
Routes come from the original OAS, not scanner output. Only newly created owner
records are mutated/deleted by this harness; no external services are involved.
"""
import atexit,json,sys,urllib.request,urllib.error
base=sys.argv[1].rstrip('/');baseline=json.load(open(sys.argv[2]));output=sys.argv[3];rows=[];completed=False
def persist():
    with open(output,'w') as file:json.dump({'scope':'Original Spring Petclinic app, isolated H2 database','completed':completed,'probes':rows},file,indent=2)
atexit.register(persist)
def call(method,path,payload=None,expected=None):
    request=urllib.request.Request(base+path,data=None if payload is None else json.dumps(payload).encode(),method=method,headers={'Content-Type':'application/json','Accept':'application/json'})
    try: response=urllib.request.urlopen(request,timeout=15)
    except urllib.error.HTTPError as error:response=error
    body=response.read().decode();status=response.status
    try:body=json.loads(body)
    except json.JSONDecodeError:pass
    rows.append({'method':method,'path':path,'status':status,'mediaType':response.headers.get('Content-Type'),'body':body})
    if expected is not None and status not in expected:raise AssertionError(f'{method} {path}: expected {expected}, got {status}: {body}')
    return status,body,response.headers
# All independently declared GET routes, using seeded record 1 for identifiers.
import re
for path,item in baseline['paths'].items():
    if 'get' not in item:continue
    endpoint='/api'+re.sub(r'\{[^}]+\}','1',path)
    call('GET',endpoint,expected=[500] if path=='/oops' else [200])
call('GET','/api/owners/999999',expected=[404])
call('GET','/api/owners/not-an-integer',expected=[500])
call('POST','/api/owners',{},expected=[400])
owner={'firstName':'Audit','lastName':'Example','address':'123 Test Street','city':'Madison','telephone':'1234567890'}
_,created,headers=call('POST','/api/owners',owner,expected=[201])
identifier=created.get('id') if isinstance(created,dict) else None
if identifier is None:identifier=int(headers['Location'].rstrip('/').split('/')[-1])
try:
    _,read,_=call('GET',f'/api/owners/{identifier}',expected=[200])
    for key,value in owner.items():assert read[key]==value,(key,read)
    owner['city']='Test City'
    call('PUT',f'/api/owners/{identifier}',owner,expected=[200,204])
    _,read,_=call('GET',f'/api/owners/{identifier}',expected=[200]);assert read['city']=='Test City'
finally:
    call('DELETE',f'/api/owners/{identifier}',expected=[200,204])
call('GET',f'/api/owners/{identifier}',expected=[404])
completed=True
persist()
print(f'{len(rows)} original Petclinic HTTP probes passed')
