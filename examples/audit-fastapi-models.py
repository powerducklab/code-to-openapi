"""Independent oracle: execute pinned upstream Pydantic models, never scanner code.
Requires Pydantic's v1 compatibility runtime and email-validator (isolated path
may be supplied as argv[3]). Does not import routes, start an app or connect to DB.
Route bindings below were manually transcribed from the pinned source.
"""
import sys, json, pathlib, subprocess
root, destination = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
commit = subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip()
assert commit == '029eb7781c60d5f563ee8990a0cbfb79b244538c'
if len(sys.argv)>3: sys.path.insert(0,sys.argv[3])
import pydantic.v1 as pydantic
sys.modules['pydantic']=pydantic
sys.path.insert(0,str(root))
from app.models.schemas.articles import ArticleForResponse, ArticleInCreate, ArticleInUpdate, ArticleInResponse, ListOfArticlesInResponse
from app.models.schemas.comments import CommentInCreate,CommentInResponse,ListOfCommentsInResponse
from app.models.schemas.profiles import ProfileInResponse
from app.models.schemas.users import UserInCreate,UserInLogin,UserInUpdate,UserInResponse
from app.models.schemas.tags import TagsInList
from app.models.domain.profiles import Profile

schemas={}
def component(cls,output=False):
    name=('output_' if output else 'input_')+cls.__name__
    if name in schemas:return {'$ref':'#/components/schemas/'+name}
    native=cls.schema(by_alias=True,ref_template='#/components/schemas/{model}')
    native.pop('definitions',None)
    schemas[name]=native
    # Independently inspect runtime fields: v1 JSON Schema omits nullable, even
    # where actual .json() emits null. Preserve that runtime behavior explicitly.
    def references(value):
        if isinstance(value,dict):
            ref=value.get('$ref')
            if ref:
                short=ref.rsplit('/',1)[-1]
                for field in cls.__fields__.values():
                    if isinstance(field.type_,type) and issubclass(field.type_,pydantic.BaseModel) and field.type_.__name__==short:
                        value['$ref']=component(field.type_,output)['$ref'];break
            for child in value.values():references(child)
        elif isinstance(value,list):
            for child in value:references(child)
    references(native)
    for field in cls.__fields__.values():
        prop=native.get('properties',{}).get(field.alias)
        if prop is None:continue
        if field.allow_none:
            if 'type' in prop:prop['type']=[prop['type'],'null']
            else:native['properties'][field.alias]={'anyOf':[prop,{'type':'null'}]}
    if output:native['required']=list(native.get('properties',{}))
    return {'$ref':'#/components/schemas/'+name}

def operation(response=None,status=200,body=None,key=None,params=()):
    out={'responses':{str(status):{'description':'Independent upstream model contract'}}}
    if response:out['responses'][str(status)]['content']={'application/json':{'schema':component(response,True)}}
    if body:out['requestBody']={'required':True,'content':{'application/json':{'schema':{'type':'object','properties':{key:component(body)},'required':[key]}}}}
    if params:out['parameters']=list(params)
    return out

def param(name,kind,schema,required=True):return {'name':name,'in':kind,'required':required,'schema':schema}
slug=param('slug','path',{'type':'string','minLength':1})
username=param('username','path',{'type':'string','minLength':1})
page=[param('limit','query',{'type':'integer','minimum':1,'default':20},False),param('offset','query',{'type':'integer','minimum':0,'default':0},False)]
paths={
 '/api/users/login':{'post':operation(UserInResponse,body=UserInLogin,key='user')},
 '/api/users':{'post':operation(UserInResponse,201,UserInCreate,'user')},
 '/api/user':{'get':operation(UserInResponse),'put':operation(UserInResponse,body=UserInUpdate,key='user')},
 '/api/articles':{'get':operation(ListOfArticlesInResponse,params=page+[param(n,'query',{'type':'string'},False) for n in ['tag','author','favorited']]),'post':operation(ArticleInResponse,201,ArticleInCreate,'article')},
 '/api/articles/feed':{'get':operation(ListOfArticlesInResponse,params=page)},
 '/api/articles/{slug}':{'get':operation(ArticleInResponse,params=[slug]),'put':operation(ArticleInResponse,body=ArticleInUpdate,key='article',params=[slug]),'delete':operation(status=204,params=[slug])},
 '/api/articles/{slug}/favorite':{'post':operation(ArticleInResponse,params=[slug]),'delete':operation(ArticleInResponse,params=[slug])},
 '/api/articles/{slug}/comments':{'get':operation(ListOfCommentsInResponse,params=[slug]),'post':operation(CommentInResponse,201,CommentInCreate,'comment',[slug])},
 '/api/articles/{slug}/comments/{comment_id}':{'delete':operation(status=204,params=[slug,param('comment_id','path',{'type':'integer','minimum':1})])},
 '/api/profiles/{username}':{'get':operation(ProfileInResponse,params=[username])},
 '/api/profiles/{username}/follow':{'post':operation(ProfileInResponse,params=[username]),'delete':operation(ProfileInResponse,params=[username])},
 '/api/tags':{'get':operation(TagsInList)},
}
profile=json.loads(Profile(username='oracle').json(by_alias=True))
assert profile=={'username':'oracle','bio':'','image':None,'following':False}
article=ArticleForResponse(slug='oracle',title='Test',description='Test',body='Test',tagList=[],author=Profile(username='oracle'),favorited=False,favoritesCount=0)
serialized=json.loads(article.json(by_alias=True))
assert 'tagList' in serialized and 'tags' not in serialized and 'favoritesCount' in serialized and serialized['createdAt'] is None
out={'openapi':'3.2.0','info':{'title':'FastAPI RealWorld independent model-runtime contracts','version':'1'},'paths':paths,'components':{'schemas':schemas},'x-audit-source':{'repository':'https://github.com/nsidnev/fastapi-realworld-example-app','commit':commit,'runtime':'Pydantic v1 compatibility '+pydantic.VERSION,'modelSource':'Unmodified app/models/**/*.py loaded from pinned source','routeSource':'Manually transcribed app/api/routes, dependencies and /api setting','limits':['Success model contracts only; exception, middleware, authentication and DB correctness not certified','Pydantic v1 compatibility runtime, not an installed original FastAPI 0.79 server','No external service contacted; database and application startup not run'],'serializationSamples':{'profile':profile,'article':serialized}}}
destination.write_text(json.dumps(out,indent=2))
print(json.dumps({'operations':sum(len(v) for v in paths.values()),'components':len(schemas),'runtime':pydantic.VERSION}))
