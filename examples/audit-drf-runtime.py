"""Native DRF contract and SQLite lifecycle checks on a pinned official sample."""
import os,sys,json,pathlib,subprocess
root=pathlib.Path(sys.argv[1]); destination=pathlib.Path(sys.argv[2])
assert subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip()=='c338449d616f613fdcbfa4ea368cdf163a0f183d'
sys.path.insert(0,str(root))
os.environ['DJANGO_SETTINGS_MODULE']='tutorial.settings'
from django.conf import settings
settings.DATABASES={'default':{'ENGINE':'django.db.backends.sqlite3','NAME':':memory:'}}
settings.PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher']
settings.MIDDLEWARE=[m for m in settings.MIDDLEWARE if 'whitenoise' not in m]
# Preserve DefaultRouter's actual lookup kwarg instead of cosmetic pk→id schema renaming.
settings.REST_FRAMEWORK={**settings.REST_FRAMEWORK,"SCHEMA_COERCE_PATH_PK":False}
import django
django.setup()
from django.core.management import call_command
from drf_spectacular.generators import SchemaGenerator
schema=SchemaGenerator().get_schema(public=True)
destination.with_name('baseline-native.json').write_text(json.dumps(schema,indent=2)+'\n')
call_command('migrate',run_syncdb=True,verbosity=0)
from django.contrib.auth.models import User
from rest_framework.test import APIClient
user=User.objects.create_user(username='contract-oracle',password='test-only')
client=APIClient();client.force_authenticate(user)
created=client.post('/snippets/',{'code':'print(1)'},format='json');assert created.status_code==201,created.data
fields={'url','id','highlight','owner','title','code','linenos','language','style'}
assert set(created.data)==fields
assert created.data['title']=='' and created.data['linenos'] is False
pk=created.data['id']; path=f'/snippets/{pk}/'
updated=client.patch(path,{'title':'oracle'},format='json');assert updated.status_code==200 and updated.data['code']=='print(1)'
invalid=client.post('/snippets/',{},format='json');assert invalid.status_code==400
listing=client.get('/snippets/');assert listing.status_code==200 and set(listing.data)=={'count','next','previous','results'}
assert set(listing.data['results'][0])==fields
html=client.get(f'/snippets/{pk}/highlight/');assert html.status_code==200 and html['Content-Type'].startswith('text/html')
removed=client.delete(path);assert removed.status_code==204 and removed.content==b''
# The native generator inherits SnippetSerializer for the HTML action. Actual
# execution above proves this endpoint returns HTML text, not a JSON object.
schema['paths']['/snippets/{pk}/highlight/']['get']['responses']['200']['content']['text/html']['schema']={'type':'string'}
destination.write_text(json.dumps(schema,indent=2)+'\n')
print(json.dumps({'paths':len(schema['paths']),'create':201,'partialUpdate':200,'invalidBody':400,'pagination':200,'highlight':200,'delete':204}))
