import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('honors keyword response status and explicit false Nested many',async()=>{
 const root=await mkdtemp(join(tmpdir(),'flask-options-'));
 try {
 await writeFile(join(root,'app.py'),`from flask import Flask
from flask_marshmallow import Marshmallow
from apifairy import response
from marshmallow import validate
app=Flask(__name__)
ma=Marshmallow(app)
class Child(ma.Schema):
    name=ma.String()
class Parent(ma.Schema):
    title=ma.String(data_key="displayTitle", required=True, validate=validate.Length(min=3, max=12))
    secret=ma.String(load_only=True)
    id=ma.Integer(dump_only=True)
    maybe=ma.String(allow_none=True)
    child=ma.Nested(Child, many=False)
    children=ma.Nested(Child, many=True)
@app.route('/parent')
@response(Parent)
def parent():
    return {}
@app.route('/empty', methods=['DELETE'])
@response(Parent, status_code=204)
def empty():
    return {}
`);
 const result=await scanProject({root});const converted=await result.convert();
 expect(converted.documentValid).toBe(true);
 const doc=converted.document as any;
 expect(doc.components.schemas.Parent.properties.displayTitle).toEqual({type:'string',minLength:3,maxLength:12});
 expect(doc.components.schemas.Parent.required).toEqual(['displayTitle']);
 expect(doc.components.schemas.Parent.properties.secret.writeOnly).toBe(true);
 expect(doc.components.schemas.Parent.properties.id.readOnly).toBe(true);
 expect(doc.components.schemas.Parent.properties.maybe.type).toEqual(['string','null']);
 expect(doc.components.schemas.Parent.properties.child).toEqual({$ref:'#/components/schemas/Child'});
 expect(doc.components.schemas.Parent.properties.children).toEqual({type:'array',items:{$ref:'#/components/schemas/Child'}});
 expect(Object.keys(doc.paths['/empty'].delete.responses)).toEqual(['204']);
 expect(doc.paths['/empty'].delete.responses['204'].content).toBeUndefined();
 } finally {await rm(root,{recursive:true,force:true});}
});

it('isolates SQL column constraints and partial request schemas',async()=>{
 const root=await mkdtemp(join(tmpdir(),'flask-sql-fields-'));
 try {
 await writeFile(join(root,'app.py'),`from flask import Flask
from flask_marshmallow import Marshmallow
from apifairy import body, response
import sqlalchemy as sa
from sqlalchemy import orm as so
app=Flask(__name__)
ma=Marshmallow(app)
class User:
    name: so.Mapped[str] = so.mapped_column(sa.String(64))
    biography: so.Mapped[str] = so.mapped_column(sa.String(280))
class UserSchema(ma.SQLAlchemySchema):
    class Meta:
        model=User
    name=ma.auto_field(required=True)
    biography=ma.auto_field()
partial_user=UserSchema(partial=True)
@app.route('/user', methods=['PUT'])
@body(partial_user)
@response(UserSchema)
def edit(data):
    return data
`);
 const result=await scanProject({root});const converted=await result.convert();
 expect(converted.documentValid).toBe(true);
 const doc=converted.document as any;
 expect(doc.components.schemas.UserSchema.properties.name).toEqual({type:'string',maxLength:64});
 expect(doc.components.schemas.UserSchema.properties.biography).toEqual({type:'string',maxLength:280});
 expect(doc.components.schemas.UserSchema.required).toEqual(['name']);
 expect(doc.components.schemas.partial_UserSchema.required).toBeUndefined();
 expect(doc.paths['/user'].put.requestBody.content['application/json'].schema.$ref).toBe('#/components/schemas/partial_UserSchema');
 }finally {await rm(root,{recursive:true,force:true});}
});

it('derives custom pagination fields and query parameters from its schema factory',async()=>{
 const root=await mkdtemp(join(tmpdir(),'flask-pagination-'));
 try {
 await writeFile(join(root,'app.py'),`from flask import Flask
from flask_marshmallow import Marshmallow
from apifairy import arguments, response
app=Flask(__name__)
ma=Marshmallow(app)
class Item(ma.Schema):
    title=ma.String()
class Page(ma.Schema):
    offset=ma.Integer()
    after=ma.String(load_only=True)
    count=ma.Integer(dump_only=True)
def collection(schema,pagination_schema=Page):
    class Collection(ma.Schema):
        records=ma.Nested(schema,many=True)
        page=ma.Nested(pagination_schema)
    return Collection
def paginated_response(schema,pagination_schema=Page):
    def inner(f):
        return arguments(pagination_schema)(response(collection(schema,pagination_schema=pagination_schema))(f))
    return inner
@app.route('/items')
@paginated_response(Item)
def items():
    return {}
`);
 const result=await scanProject({root});const converted=await result.convert();
 expect(converted.documentValid).toBe(true);
 const doc=converted.document as any;const op=doc.paths['/items'].get;
 expect(op.parameters.map((p:any)=>p.name).sort()).toEqual(['after','offset']);
 expect(op.responses['200'].content['application/json'].schema.properties).toEqual({records:{type:'array',items:{$ref:'#/components/schemas/Item'}},page:{$ref:'#/components/schemas/Page'}});
 }finally {await rm(root,{recursive:true,force:true});}
});
