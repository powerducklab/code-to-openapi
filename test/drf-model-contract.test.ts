import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('retains model fields, pagination, read-only viewsets, partial input and HTML actions',async()=>{
 const root=await mkdtemp(join(tmpdir(),'drf-model-contract-'));
 try {
 await writeFile(join(root,'requirements.txt'),'Django==6.1.1\ndjangorestframework==3.18.1');
 await writeFile(join(root,'app.py'),`from django.db import models
from django.urls import path,include
from rest_framework import serializers,viewsets,renderers
from rest_framework.routers import DefaultRouter
from rest_framework.decorators import action
from rest_framework.response import Response
REST_FRAMEWORK={'DEFAULT_PAGINATION_CLASS':'rest_framework.pagination.PageNumberPagination'}
class Snippet(models.Model):
    title=models.CharField(max_length=100,blank=True,default='')
    code=models.TextField()
class SnippetSerializer(serializers.HyperlinkedModelSerializer):
    class Meta:
        model=Snippet
        fields=('url','id','title','code')
class SnippetViewSet(viewsets.ModelViewSet):
    serializer_class=SnippetSerializer
    @action(detail=True,renderer_classes=[renderers.StaticHTMLRenderer])
    def highlight(self,request):
        return Response('<p>hello</p>')
class ReadViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class=SnippetSerializer
router=DefaultRouter()
router.register('snippets',SnippetViewSet,basename='snippet')
router.register('read',ReadViewSet,basename='read')
urlpatterns=[path('',include(router.urls))]
`);
 const result=await scanProject({root});const converted=await result.convert();expect(converted.documentValid).toBe(true);
 const doc=converted.document as any;
 expect(Object.keys(doc.paths['/read/'])).toEqual(['get']);
 const schemas=doc.components.schemas;
 expect(schemas.SnippetSerializer.properties.title).toEqual({type:'string',maxLength:100});
 expect(schemas.SnippetSerializer.properties.code).toEqual({type:'string',minLength:1});
 expect(schemas.SnippetSerializer.required).toContain('code');
 expect(schemas.partial_SnippetSerializer.required).toBeUndefined();
 const patch=doc.paths['/snippets/{pk}/'].patch;
 expect(patch.parameters[0].schema.type).toBe('integer');
 expect(Object.keys(patch.requestBody.content).sort()).toEqual(['application/json','application/x-www-form-urlencoded','multipart/form-data']);
 expect(patch.requestBody.required).not.toBe(true);
 const list=doc.paths['/snippets/'].get;
 expect(list.parameters.some((p:any)=>p.name==='page')).toBe(true);
 expect(list.responses['200'].content['application/json'].schema.properties.results.items.$ref).toContain('SnippetSerializer');
 expect(doc.paths['/snippets/{pk}/highlight/'].get.responses['200'].content['text/html'].schema).toEqual({type:'string'});
 }finally{await rm(root,{recursive:true,force:true});}
});
