"""Independent source oracle for recipes/swagger at 47a33121aee2607fcfa49696db0a0d358d844a72.
Manually transcribed from handlers/book.go and models/book.go, not scan output.
Covers declared Book fields; external gorm.Model fields are explicitly NOT covered.
"""
import json, pathlib
string = {'type':'string'}
props = {name: dict(string) for name in ['title','author','publisher']}
book_input = {'type':'object','properties':props}
book_output = {'type':'object','properties':props,'required':list(props)}
def envelope(data):
    return {'type':'object','properties':{'success':{'type':'boolean'},'message':string,'data':data},'required':['success','message','data']}
def response(data):
    return {'description':'','content':{'application/json':{'schema':envelope(data)}}}
null = {'type':'null'}
id_param = {'in':'path','name':'id','required':True,'schema':string}
paths = {
 '/v1/books':{
  'get':{'responses':{'200':response({'type':'array','items':book_output}),'503':response(null)}},
  'post':{'requestBody':{'required':True,'content':{'application/json':{'schema':book_input}}},'responses':{'200':response(book_output),'400':response(null)}}},
 '/v1/books/{id}':{
  'get':{'parameters':[id_param],'responses':{'200':response(book_output),'404':response(null),'503':response(null)}},
  'delete':{'parameters':[id_param],'responses':{'200':response(null),'404':response(null),'503':response(null)}}}
}
out=pathlib.Path(__file__).resolve().parent.parent/'docs/audits/2026-10-04-hardening/fiber-source-baseline.json'
out.write_text(json.dumps({'openapi':'3.2.0','info':{'title':'Fiber source-known fields oracle','version':'1'},'paths':paths,'x-audit-exclusions':['External gorm.Model fields and DB behavior are not certified.','Nil slices may serialize null; this baseline describes the intended populated collection response.']},indent=2))
