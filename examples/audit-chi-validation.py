"""Compile the original DTO declarations with their pinned native validator.
No application/database startup. The original declarations are copied verbatim
apart from the package name required by the isolated executable.
"""
import hashlib, json, os, pathlib, subprocess, sys, tempfile
root, destination = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]).resolve()
source = root / 'internal/models/dto.go'
raw = source.read_bytes()
with tempfile.TemporaryDirectory(prefix='pd-chi-validator-') as folder:
    work = pathlib.Path(folder)
    (work / 'go.mod').write_text('module oracle\n\ngo 1.25.0\n\nrequire github.com/go-playground/validator/v10 v10.30.1\n')
    (work / 'go.sum').write_bytes((root / 'go.sum').read_bytes())
    (work / 'dto.go').write_text(raw.decode().replace('package models', 'package main', 1))
    (work / 'main.go').write_text(r'''package main
import("encoding/json";"fmt";"os";"github.com/go-playground/validator/v10")
func main(){
 v:=validator.New(); rows:=[]map[string]any{}
 for _,c:=range []struct{body string;valid bool}{
 {`{}`,false},{`{"title":null}`,false},{`{"title":""}`,false},
 {`{"title":"ok"}`,true},{`{"title":"ok","content":null}`,true},
 {`{"title":"ok","content":""}`,false},{`{"title":"ok","content":"x"}`,true},
 }{
 var input UpdateDTO; err:=json.Unmarshal([]byte(c.body),&input);if err==nil{err=v.Struct(input)}
 valid:=err==nil;if valid!=c.valid{panic(fmt.Sprintf("%s: %v",c.body,err))}
 rows=append(rows,map[string]any{"body":json.RawMessage(c.body),"valid":valid})
 }
 output,_:=json.MarshalIndent(rows,"","  ");if err:=os.WriteFile(os.Args[1],output,0600);err!=nil{panic(err)}
 fmt.Println(len(rows),"native original Chi DTO validation probes passed")
}
''')
    env = dict(os.environ, GOCACHE='/tmp/pd-go-json-cache', GOMODCACHE='/tmp/pd-go-modules', GOTOOLCHAIN='local')
    subprocess.run(['/usr/local/go/bin/go', 'run', '-mod=mod', '.', str(destination)], cwd=work, env=env, check=True)
    rows=json.loads(destination.read_text())
    destination.write_text(json.dumps({'source':'internal/models/dto.go','sha256':hashlib.sha256(raw).hexdigest(),'validator':'github.com/go-playground/validator/v10@v10.30.1','probes':rows},indent=2)+'\n')
