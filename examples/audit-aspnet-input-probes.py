"""Read-only invalid-input probes against disposable local Conduit only."""
import json,sys
from urllib.request import Request,urlopen
from urllib.error import HTTPError
cases=[('/api/users',None),('/api/users',{}),('/api/users',{'user':{}}),
       ('/api/users',{'user':{'username':'probe','email':'probe@example.test','password':'short'}}),
       ('/api/users/login',None),('/api/users/login',{}),('/api/users/login',{'user':{}})]
rows=[]
for path,data in cases:
    request=Request('http://127.0.0.1:18762'+path,data=json.dumps(data).encode() if data is not None else b'',headers={'Content-Type':'application/json','Accept':'application/json'},method='POST')
    try: response=urlopen(request,timeout=15)
    except HTTPError as error: response=error
    raw=response.read()
    try: payload=json.loads(raw)
    except ValueError: payload={}
    assert response.status>=400,('Invalid probe unexpectedly succeeded',path,response.status)
    rows.append({'method':'post','path':path,'input':data,'status':response.status,'errorFields':list(payload.get('errors',{})) if isinstance(payload,dict) else []})
with open(sys.argv[1],'w') as output:json.dump(rows,output,indent=2)
print(len(rows),'invalid-input probes')
