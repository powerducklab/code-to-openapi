import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('respects DRF decimal wire coercion and refuses dynamic guesses',async()=>{
 const root=await mkdtemp(join(tmpdir(),'drf-decimal-'));
 try{
 const source=`from rest_framework import serializers,viewsets
from rest_framework.routers import DefaultRouter
from django.urls import path,include
class AmountSerializer(serializers.Serializer):
    amount=serializers.DecimalField(max_digits=6,decimal_places=2)
    numeric=serializers.DecimalField(max_digits=6,decimal_places=2,coerce_to_string=False)
    text=serializers.DecimalField(max_digits=6,decimal_places=2,coerce_to_string=True)
    dynamic=serializers.DecimalField(max_digits=6,decimal_places=2,coerce_to_string=runtime_option)
class AmountViewSet(viewsets.ModelViewSet):
    serializer_class=AmountSerializer
router=DefaultRouter()
router.register('amounts',AmountViewSet,basename='amount')
urlpatterns=[path('',include(router.urls))]
`;
 await writeFile(join(root,'requirements.txt'),'djangorestframework==3.13.1');
 for(const config of ['',"REST_FRAMEWORK={'COERCE_DECIMAL_TO_STRING':False}","REST_FRAMEWORK={'COERCE_DECIMAL_TO_STRING':runtime_option}"]){
  await writeFile(join(root,'app.py'),source+'\n'+config);
  const doc=(await (await scanProject({root})).convert()).document as any;
  const fields=doc.components.schemas.AmountSerializer.properties;
  expect(fields.amount.type).toBe(config.includes('runtime_option')?undefined:config?'number':'string');
  expect(fields.numeric.type).toBe('number');expect(fields.text.type).toBe('string');expect(fields.dynamic.type).toBeUndefined();
 }
 }finally{await rm(root,{recursive:true,force:true});}
});
