"""Record original Maven/Gradle JUnit reports without treating zero tests as success."""
import hashlib,json,pathlib,subprocess,sys,xml.etree.ElementTree as ET
root=pathlib.Path(sys.argv[1]); reports=pathlib.Path(sys.argv[2]); output=pathlib.Path(sys.argv[3])
suites=[]
for file in sorted(reports.glob('TEST-*.xml')):
    raw=file.read_bytes(); suite=ET.fromstring(raw)
    suites.append({'name':suite.attrib['name'],**{key:int(suite.attrib.get(key,'0')) for key in ['tests','failures','errors','skipped']},'seconds':float(suite.attrib.get('time','0')),'reportSha256':hashlib.sha256(raw).hexdigest()})
totals={key:sum(suite[key] for suite in suites) for key in ['tests','failures','errors','skipped']}
result={'commit':subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip(),'totals':totals,'suites':suites}
output.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(totals))
if not totals['tests'] or totals['errors'] or totals['failures']:sys.exit(1)
