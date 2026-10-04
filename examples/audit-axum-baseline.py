"""Independent source route/status transcription, native Serde DTO evidence."""
import json
from pathlib import Path
out=Path(__file__).resolve().parent.parent/'docs/audits/2026-10-04-axum'
native=json.loads((out/'native.json').read_text())
def schema(v,key=''):
 if v is None:return {'type':['string','null']} # original image: Option<String>
 if isinstance(v,bool):return {'type':'boolean'}
 if isinstance(v,str):return {'type':'string',**({'format':'date-time'} if key in ['createdAt','updatedAt'] else {})}
 if isinstance(v,int):return {'type':'integer','format':'int64'}
 if isinstance(v,list):return {'type':'array','items':schema(v[0]) if v else {}}
 return {'type':'object','properties':{k:schema(value,k) for k,value in v.items()},'required':list(v)}
def response(name):return {'description':'Original Serde output','content':{'application/json':{'schema':schema(native['responses'][name])}}} if name else {'description':'Original Result<()> success'}
def body(name,wrapper,fields,optional=False):
 props={k:({'type':['string','null']} if optional else {'type':'string'}) for k in fields}
 if name=='CreateArticle':props['tagList']={'type':'array','items':{'type':'string'}}
 obj={'type':'object','properties':props,'required':native['required'][name]}
 return {'required':True,'content':{'application/json':{'schema':{'type':'object','properties':{wrapper:obj},'required':[wrapper]}}}}
paths={}
def op(path,method,resp,request=None,query=None):
 params=[]
 for key in ['username','slug','comment_id']:
  if '{'+key+'}' in path:params.append({'name':key,'in':'path','required':True,'schema':{'type':'integer','format':'int64'} if key=='comment_id' else {'type':'string'}})
 for key in query or []:params.append({'name':key,'in':'query','required':False,'schema':{'type':'integer','format':'int64'} if key in ['limit','offset'] else {'type':'string'}})
 paths.setdefault(path,{})[method]={'responses':{'200':response(resp)},**({'parameters':params} if params else {}),**({'requestBody':request} if request else {})}
op('/api/users','post','user',body('NewUser','user',['email','username','password']))
op('/api/users/login','post','user',body('LoginUser','user',['email','password']))
op('/api/user','get','user');op('/api/user','put','user',body('UpdateUser','user',['email','username','password','bio','image'],True))
op('/api/profiles/{username}','get','profile')
for method in ['post','delete']:op('/api/profiles/{username}/follow',method,'profile')
op('/api/articles','post','article',body('CreateArticle','article',['title','description','body']))
op('/api/articles','get','articles',query=['tag','author','favorited','limit','offset'])
op('/api/articles/feed','get','articles',query=['limit','offset'])
op('/api/articles/{slug}','get','article');op('/api/articles/{slug}','put','article',body('UpdateArticle','article',['title','description','body'],True));op('/api/articles/{slug}','delete',None)
for method in ['post','delete']:op('/api/articles/{slug}/favorite',method,'article')
op('/api/tags','get','tags');op('/api/articles/{slug}/comments','get','comments');op('/api/articles/{slug}/comments','post','comment',body('AddComment','comment',['body']));op('/api/articles/{slug}/comments/{comment_id}','delete',None)
(out/'baseline.json').write_text(json.dumps({'openapi':'3.2.0','info':{'title':'Independent Axum Serde baseline','version':'1'},'paths':paths},indent=2)+'\n')
