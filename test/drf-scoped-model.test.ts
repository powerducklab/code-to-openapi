import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('binds DRF Meta.model by its import rather than a matching class name',async()=>{
 const root=await mkdtemp(join(tmpdir(),'drf-scope-'));
 try{
  await writeFile(join(root,'requirements.txt'),'djangorestframework==3.13.1');
  await writeFile(join(root,'one.py'),`from django.db import models
class Item(models.Model):
    value=models.IntegerField()
`);
  await writeFile(join(root,'two.py'),`from django.db import models
class Item(models.Model):
    value=models.CharField(max_length=12)
`);
  await writeFile(join(root,'app.py'),`from rest_framework import serializers,viewsets
from rest_framework.routers import DefaultRouter
from django.urls import path,include
from two import Item as Chosen
from absent import Item
class ChosenSerializer(serializers.ModelSerializer):
    class Meta:
        model=Chosen
        fields=('id','value')
class MissingSerializer(serializers.ModelSerializer):
    class Meta:
        model=Item
        fields=('id','value')
class ChosenViewSet(viewsets.ModelViewSet):
    serializer_class=ChosenSerializer
class MissingViewSet(viewsets.ModelViewSet):
    serializer_class=MissingSerializer
router=DefaultRouter()
router.register('chosen',ChosenViewSet,basename='chosen')
router.register('missing',MissingViewSet,basename='missing')
urlpatterns=[path('',include(router.urls))]
`);
 const doc=(await (await scanProject({root})).convert()).document as any;
 expect(doc.components.schemas.ChosenSerializer.properties.value).toEqual({type:'string',minLength:1,maxLength:12});
 expect(doc.components.schemas.ChosenSerializer.required).toContain('value');
 expect(doc.components.schemas.MissingSerializer.properties.value).toEqual({});
 }finally{await rm(root,{recursive:true,force:true});}
});
