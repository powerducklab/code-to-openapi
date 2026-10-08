import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {scanProject} from '../src/index.js';
it('tracks CommonJS Sequelize factories, query callbacks and non-null branches',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sequelize-api-'));
 try{
 await mkdir(join(root,'models'));
 await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{express:'4',sequelize:'6'}}));
 await writeFile(join(root,'models/index.js'),`const Sequelize=require('sequelize');const sequelize=new Sequelize('db','user','password',{dialect:'mysql'});const db={};db.item=require('./item')(sequelize,Sequelize);module.exports=db;`);
 await writeFile(join(root,'models/item.js'),`module.exports=(sequelize,Types)=>{const Item=sequelize.define('item',{title:{type:Types.STRING},published:{type:Types.BOOLEAN}});return Item;};`);
 await writeFile(join(root,'app.js'),`const express=require('express');const app=express();const db=require('./models');const Item=db.item;
 app.get('/items/:id',(req,res)=>Item.findByPk(req.params.id).then(data=>{if(data)res.send(data);else res.status(404).send({message:'Missing'});}).catch(err=>res.status(500).send({message:'Error'})));
 app.get('/items',(req,res)=>Item.findAll().then(data=>res.send(data)));
 app.get('/nullable',(req,res)=>Item.findByPk(1).then(data=>res.json(data)));
 app.get('/projected',(req,res)=>Item.findAll({attributes:['title']}).then(data=>res.send(data)));
 `);
 const result=await scanProject({root,frameworks:['express']});
 const one=result.project.operations.find(op=>op.path==='/items/{id}')!;
 expect(one.responses.map(r=>r.statusCode).sort()).toEqual(['200','404','500']);
 const shape=one.responses.find(r=>r.statusCode==='200')!.content![0]!.schema as any;
 expect(shape.type).toBe('object');
 expect(shape.properties).toMatchObject({id:{type:'integer'},title:{type:['string','null']},published:{type:['boolean','null']},createdAt:{type:'string',format:'date-time'},updatedAt:{type:'string',format:'date-time'}});
 expect(one.gaps).not.toContain('response-schema-unknown');
 const all=result.project.operations.find(op=>op.path==='/items')!.responses[0]!.content![0]!.schema as any;
 expect(all.type).toBe('array');expect(all.items.properties).toEqual(shape.properties);
 const nullable=result.project.operations.find(op=>op.path==='/nullable')!.responses[0]!.content![0]!.schema as any;
 expect(nullable.anyOf).toContainEqual({type:'null'});
 const projected=result.project.operations.find(op=>op.path==='/projected')!;
 expect((projected.responses[0]!.content![0]!.schema as any).items.properties).toEqual({title:{type:['string','null']}});
 expect(projected.gaps).not.toContain('response-schema-unknown');
 expect((await result.convert()).documentValid).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});

it('separates storage metadata, static projections and opaque serialization across ESM models',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sequelize-esm-'));
 try{
 await writeFile(join(root,'package.json'),JSON.stringify({type:'module',dependencies:{express:'4',sequelize:'6'}}));
 await writeFile(join(root,'models.js'),`import {Sequelize,DataTypes} from 'sequelize';
 const sql=new Sequelize('db','user','pass',{dialect:'mysql',define:{timestamps:false}});
 export const Entry=sql.define('Entry',{id:{type:DataTypes.INTEGER,primaryKey:true},name:DataTypes.STRING,secret:DataTypes.STRING},{comment:'metadata',indexes:[{fields:['name']}],defaultScope:{attributes:{exclude:['secret']}}});
 export const Custom=sql.define('Custom',{name:DataTypes.STRING},{hooks:{afterFind(value){return transform(value)}}});
 `);
 await writeFile(join(root,'app.js'),`import express from 'express';import {Entry,Custom} from './models.js';const app=express();
 app.get('/entries',(req,res)=>Entry.findAll().then(data=>res.json(data)));
 app.get('/selected',(req,res)=>Entry.findAll({attributes:['secret']}).then(data=>res.json(data)));
 app.get('/custom',(req,res)=>Custom.findAll().then(data=>res.json(data)));
 `);
 const result=await scanProject({root,frameworks:['express']});
 const entry=result.project.operations.find(op=>op.path==='/entries')!;
 const shape=entry.responses[0]!.content![0]!.schema as any;
 expect(Object.keys(shape.items.properties).sort()).toEqual(['id','name']);
 expect(entry.gaps).not.toContain('response-schema-unknown');
 const selected=result.project.operations.find(op=>op.path==='/selected')!;
 expect(Object.keys((selected.responses[0]!.content![0]!.schema as any).items.properties)).toEqual(['secret']);
 const custom=result.project.operations.find(op=>op.path==='/custom')!;
 expect(custom.gaps).toContain('response-schema-unknown');
 const opaque=custom.responses[0]!.content![0]!.schema as any;
 expect(opaque.items.anyOf[0].properties.name).toEqual({type:['string','null']});
 expect(opaque.items['x-discovery-incomplete']).toContain('Unresolved model option: hooks');
 expect((await result.convert()).documentValid).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});
