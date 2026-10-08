import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {scanProject} from '../src/index.js';
it('uses custom delete response statuses and JSON fields instead of inventing 204',async()=>{
 const root=await mkdtemp(join(tmpdir(),'drf-delete-'));
 try {
  await writeFile(join(root,'requirements.txt'),'djangorestframework');
  await writeFile(join(root,'views.py'),`from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status, serializers
from drf_spectacular.utils import extend_schema
class InputSerializer(serializers.Serializer):
    name = serializers.CharField()
class OutputSerializer(serializers.Serializer):
    id = serializers.IntegerField()
class ItemView(APIView):
    @extend_schema(request=InputSerializer)
    def post(self, request, pk):
        serializer = OutputSerializer({"id": 1})
        return Response(serializer.data, status=201)
    def delete(self, request, pk):
        if request.user.is_anonymous:
            return Response({"error": True, "message": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)
        return Response({"error": False, "message": "Deleted"}, status=status.HTTP_200_OK)
`);
  await writeFile(join(root,'urls.py'),`from django.urls import path
from views import ItemView
urlpatterns=[path("items/<int:pk>/",ItemView.as_view())]
`);
  const result=await scanProject({root,frameworks:['drf']});
  const op=result.project.operations.find(op=>op.method==='delete')!;
  const post=result.project.operations.find(op=>op.method==='post')!;
  expect(post.requestBody?.content?.[0]?.schema).toEqual({$ref:'#/components/schemas/InputSerializer'});
  expect(post.responses[0]?.content?.[0]?.schema).toEqual({$ref:'#/components/schemas/OutputSerializer'});
  expect(op.responses.map(r=>r.statusCode).sort()).toEqual(['200','403']);
  expect(op.responses[0]!.content?.[0]?.schema).toMatchObject({type:'object',properties:{error:{type:'boolean'},message:{type:'string'}}});
  expect(op.origin?.file).toBe('views.py');
  expect(op.gaps).not.toContain('response-schema-unknown');
 }finally{await rm(root,{recursive:true,force:true});}
});
