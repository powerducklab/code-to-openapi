import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {scanProject} from '../src/index.js';
it('expands all and excluded model fields, including inherited and custom primary keys',async()=>{
 const root=await mkdtemp(join(tmpdir(),'drf-all-'));
 try{
 await writeFile(join(root,'requirements.txt'),'djangorestframework');
 await writeFile(join(root,'app.py'),`from django.db import models
from django.urls import path, include
from rest_framework import serializers,viewsets
from rest_framework.routers import DefaultRouter
class Base(models.Model):
    created=models.DateTimeField(auto_now_add=True)
    class Meta:
        abstract=True
class Item(Base):
    key=models.UUIDField(primary_key=True)
    title=models.CharField(max_length=64)
    secret=models.CharField(max_length=64)
class ItemSerializer(serializers.ModelSerializer):
    class Meta:
        model=Item
        fields='__all__'
class PublicSerializer(serializers.ModelSerializer):
    class Meta:
        model=Item
        exclude=('secret',)
class ItemViewSet(viewsets.ModelViewSet):
    serializer_class=ItemSerializer
class PublicViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class=PublicSerializer
router=DefaultRouter()
router.register('items',ItemViewSet)
router.register('public',PublicViewSet)
urlpatterns=[path('',include(router.urls))]
`);
 const result=await scanProject({root,frameworks:['drf']});
 const converted=await result.convert();
 expect(converted.documentValid).toBe(true);
 const schemas=(converted.document as any).components.schemas;
 expect(Object.keys(schemas.ItemSerializer.properties).sort()).toEqual(['created','key','secret','title']);
 expect(schemas.ItemSerializer.properties.key).toMatchObject({type:'string',format:'uuid'});
 expect(schemas.ItemSerializer.properties.key.readOnly).toBeUndefined();
 expect(schemas.ItemSerializer.properties.created).toMatchObject({type:'string',format:'date-time',readOnly:true});
 expect(schemas.ItemSerializer.required).toContain('title');
 expect(schemas.ItemSerializer.required).toContain('key');
 expect(schemas.PublicSerializer.properties.secret).toBeUndefined();
 expect(Object.keys(schemas.PublicSerializer.properties).sort()).toEqual(['created','key','title']);
 }finally{await rm(root,{recursive:true,force:true});}
});
