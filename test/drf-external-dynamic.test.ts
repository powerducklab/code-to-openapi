import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';

// Covers P1-3 DRF gaps: external auth.User model fields, ReadOnlyField(source=...)
// mapping, and dynamic choices that cannot be statically enumerated (flagged,
// never fabricated).
it('resolves external auth.User fields, ReadOnlyField source and dynamic choices',async()=>{
 const root=await mkdtemp(join(tmpdir(),'drf-external-'));
 try {
 await writeFile(join(root,'requirements.txt'),'Django==6.1.1\ndjangorestframework==3.18.1');
 await writeFile(join(root,'app.py'),`from django.db import models
from django.contrib.auth.models import User
from django.urls import path,include
from rest_framework import serializers,viewsets
from rest_framework.routers import DefaultRouter
from pygments.styles import get_all_styles
LANGUAGE_CHOICES=sorted((item,item) for item in get_all_styles())
class Snippet(models.Model):
    title=models.CharField(max_length=100,blank=True,default='')
    language=models.CharField(choices=LANGUAGE_CHOICES,default='python',max_length=100)
    owner=models.ForeignKey('auth.User',related_name='snippets',on_delete=models.CASCADE)
class SnippetSerializer(serializers.HyperlinkedModelSerializer):
    owner=serializers.ReadOnlyField(source='owner.username')
    class Meta:
        model=Snippet
        fields=('url','id','title','language','owner')
class UserSerializer(serializers.HyperlinkedModelSerializer):
    class Meta:
        model=User
        fields=('url','id','username')
class SnippetViewSet(viewsets.ModelViewSet):
    serializer_class=SnippetSerializer
class UserViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class=UserSerializer
router=DefaultRouter()
router.register('snippets',SnippetViewSet,basename='snippet')
router.register('users',UserViewSet,basename='user')
urlpatterns=[path('',include(router.urls))]
`);
 const converted=await (await scanProject({root})).convert();
 expect(converted.documentValid).toBe(true);
 const schemas=(converted.document as any).components.schemas;

 // ReadOnlyField(source='owner.username') renders a read-only string.
 expect(schemas.SnippetSerializer.properties.owner).toEqual({type:'string',readOnly:true});

 // Dynamic choices are honestly flagged, never enumerated from a runtime call.
 const language=schemas.SnippetSerializer.properties.language;
 expect(language['x-dynamic-enum']).toBe(true);
 expect(language.enum).toBeUndefined();
 expect(language.type).toBe('string');

 // External django.contrib.auth.models.User stock fields.
 expect(schemas.UserSerializer.properties.id).toEqual({type:'integer',readOnly:true});
 expect(schemas.UserSerializer.properties.username).toEqual({
   type:'string',maxLength:150,pattern:'^[\\w.@+-]+$',
 });
 expect(schemas.UserSerializer.required).toContain('id');
 expect(schemas.UserSerializer.required).toContain('username');
 } finally {
  await rm(root,{recursive:true,force:true});
 }
});
