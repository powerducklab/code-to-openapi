"""Export unmodified upstream APIFairy contract using isolated in-memory config."""
import sys,json,pathlib,subprocess
root=pathlib.Path(sys.argv[1]);destination=pathlib.Path(sys.argv[2])
assert subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip()=='e250d7115b47010ff0e7051d5868485fff4e32fb'
sys.path.insert(0,str(root))
from api.app import create_app
from tests.base_test_case import TestConfig
app=create_app(TestConfig)
response=app.test_client().get('/apispec.json')
assert response.status_code==200
spec=response.get_json()
assert len(spec['paths'])==16
# Contract generation makes no external requests and does not create a database.
destination.write_text(json.dumps(spec,indent=2)+'\n')
print(json.dumps({'paths':len(spec['paths']),'schemas':len(spec['components']['schemas'])}))
