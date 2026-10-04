"""Independent wire probes for the pinned, unmodified Quarkus CRUD example."""
import atexit,json,sys,urllib.request,urllib.error
base=sys.argv[1].rstrip('/'); output=sys.argv[2]; rows=[]; completed=False
def persist():
    with open(output,'w') as file:json.dump({'completed':completed,'scope':'Original Quarkus in-memory example; localhost only','probes':rows},file,indent=2)
atexit.register(persist)
def call(method,path,expected,payload=None,raw=None):
    data=raw if raw is not None else None if payload is None else json.dumps(payload).encode()
    req=urllib.request.Request(base+path,data=data,method=method,headers={'Content-Type':'application/json'})
    try: response=urllib.request.urlopen(req,timeout=15)
    except urllib.error.HTTPError as error: response=error
    body=response.read().decode()
    try: body=json.loads(body)
    except json.JSONDecodeError: pass
    rows.append({'method':method,'path':path,'status':response.status,'mediaType':response.headers.get('Content-Type'),'body':body})
    assert response.status==expected,(method,path,response.status,body)
    return body
assert call('GET','/hello',200)=='Hello from RESTEasy Reactive'
error=call('GET','/test_exception',400)
assert error['errorMessage']=='Testing BAD_REQUEST',error
initial=call('GET','/example_model',200)
assert all(set(row)=={'fieldA','fieldB'} for row in initial),initial
value={'fieldA':'Native audit record','fieldB':'Contract verification'}
try:
    created=call('POST','/example_model',200,value)
    assert value in created,created
    assert value in call('GET','/example_model',200)
finally:
    remaining=call('DELETE','/example_model',200,value)
assert value not in remaining,remaining
# Quarkus 2.11.2 propagates JsonParseException to its generic 500 handler.
call('POST','/example_model',500,raw=b'{broken')
# The original DTO has no validation annotations: absent fields are accepted.
empty=call('POST','/example_model',200,{})
assert {'fieldA':None,'fieldB':None} in empty,empty
call('DELETE','/example_model',200,{})
completed=True;persist();print(f'{len(rows)} original Quarkus HTTP probes passed')
