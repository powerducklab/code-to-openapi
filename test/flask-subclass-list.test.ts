import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {scanProject} from '../src/index.js';
it('mounts a Flask subclass through imported starred blueprint lists',async()=>{
 const root=await mkdtemp(join(tmpdir(),'flask-subclass-'));
 try {
  await mkdir(join(root,'api'));
  await writeFile(join(root,'requirements.txt'),'flask');
  await writeFile(join(root,'api','base.py'),'from flask import Flask\nclass BaseFlask(Flask):\n    pass\n');
  await writeFile(join(root,'api','routes.py'),`from flask import Blueprint
bp=Blueprint('users',__name__)
@bp.route('/users',methods=['GET'])
def users():
    return {'ok':True}
`);
  await writeFile(join(root,'api','registry.py'),'from .routes import bp\nblueprints=[bp]\n');
  await writeFile(join(root,'api','__init__.py'),`from .base import BaseFlask
from .registry import blueprints as users
def create_app():
    app=BaseFlask(__name__)
    registrations=[*users]
    for bp in registrations:
        app.register_blueprint(bp,url_prefix='/v1')
    return app
app=create_app()
`);
  const result=await scanProject({root,frameworks:['flask']});
  expect(result.project.operations.map(op=>op.path)).toEqual(['/v1/users']);
 }finally{await rm(root,{recursive:true,force:true});}
});
it('does not replace dynamic prefixes with empty paths and honors explicit empty overrides',async()=>{
 const root=await mkdtemp(join(tmpdir(),'flask-prefix-'));
 try{
 await writeFile(join(root,'requirements.txt'),'flask');
 await writeFile(join(root,'app.py'),`from flask import Flask,Blueprint
import os
app=Flask(__name__)
a=Blueprint('a',__name__,url_prefix='/old')
b=Blueprint('b',__name__,url_prefix=os.getenv('PREFIX'))
c=Blueprint('c',__name__)
@a.get('/a')
def get_a():return {'ok':True}
@b.get('/b')
def get_b():return {'ok':True}
@c.get('/c')
def get_c():return {'ok':True}
app.register_blueprint(a,url_prefix='')
app.register_blueprint(b)
app.register_blueprint(c,url_prefix=os.getenv('PREFIX'))
`);
 const result=await scanProject({root,frameworks:['flask']});
 expect(result.project.operations.map(op=>op.path)).toEqual(['/a']);
 }finally{await rm(root,{recursive:true,force:true});}
});
