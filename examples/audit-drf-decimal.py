"""Probe installed DRF JSON output, independently of scanner inference."""
import json,sys
from decimal import Decimal
from django.conf import settings
settings.configure(USE_I18N=False,REST_FRAMEWORK={})
from django.test import override_settings
from rest_framework import serializers,VERSION
from rest_framework.renderers import JSONRenderer
rows=[]
for global_value in [True,False]:
    with override_settings(REST_FRAMEWORK={'COERCE_DECIMAL_TO_STRING':global_value}):
        for local_value in [None,True,False]:
            field=serializers.DecimalField(max_digits=6,decimal_places=2,**({} if local_value is None else {'coerce_to_string':local_value}))
            result=json.loads(JSONRenderer().render(field.to_representation(Decimal('12.30'))))
            string=global_value if local_value is None else local_value
            assert isinstance(result,str) == string,(global_value,local_value,result)
            rows.append({'global':global_value,'explicit':local_value,'jsonValue':result})
with open(sys.argv[1],'w') as file:json.dump({'drfVersion':VERSION,'probes':rows},file,indent=2)
print(f'{len(rows)} native DRF decimal probes passed')
